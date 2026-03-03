/**
 * OpenCV-based Vision Processor
 *
 * Uses OpenCV for:
 * 1. Message strip segmentation (horizontal projection)
 * 2. Template matching for attachment clicks
 * 3. Rule-based image region detection
 */
import cv from 'opencv4nodejs-prebuilt';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import { logger } from '../utils/logger.js';

export interface MessageBlock {
  x: number;
  y: number;
  w: number;
  h: number;
  type: 'text' | 'image' | 'file' | 'mixed';
  crop?: cv.Mat;
}

export interface SegmentResult {
  blocks: MessageBlock[];
  image: cv.Mat;
}

export interface TemplateMatchResult {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

/**
 * Segment message strips from chat screenshot using horizontal projection
 */
export function segmentMessageStrips(img: cv.Mat): MessageBlock[] {
  const blocks: MessageBlock[] = [];

  // 1) Convert to grayscale
  const gray = img.bgrToGray();

  // 2) Apply Gaussian blur to reduce noise
  const blurred = gray.gaussianBlur(new cv.Size(3, 3), 0);

  // 3) Apply Otsu's thresholding
  const binary = blurred.threshold(0, 255, cv.THRESH_OTSU);

  // 4) Calculate horizontal projection (count of black pixels per row)
  const rows = binary.rows;
  const cols = binary.cols;
  const proj = new Array(rows).fill(0);

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const pixel = binary.at(y, x);
      if (pixel === 0) {
        proj[y]++;
      }
    }
  }

  // 5) Find horizontal gap segments (blank rows between messages)
  // Threshold: row has less than 3% black pixels = blank
  const blankThreshold = cols * 0.03;
  const minGapHeight = 8; // minimum gap height to consider as separator

  const gaps: { start: number; end: number }[] = [];
  let runningStart: number | null = null;

  for (let y = 0; y < rows; y++) {
    if (proj[y] < blankThreshold) {
      if (runningStart === null) {
        runningStart = y;
      }
    } else {
      if (runningStart !== null) {
        const gapHeight = y - runningStart;
        if (gapHeight >= minGapHeight) {
          gaps.push({ start: runningStart, end: y });
        }
        runningStart = null;
      }
    }
  }

  // Handle case where last row is blank
  if (runningStart !== null && rows - runningStart >= minGapHeight) {
    gaps.push({ start: runningStart, end: rows });
  }

  // 6) Extract blocks between gaps
  let prevEnd = 0;
  for (const gap of gaps) {
    if (gap.start - prevEnd > 20) {
      // Minimum block height
      blocks.push({
        x: 0,
        y: prevEnd,
        w: cols,
        h: gap.start - prevEnd,
        type: 'text', // will be refined later
      });
    }
    prevEnd = gap.end;
  }

  // Handle last block if there's content after the last gap
  if (prevEnd < rows - 20) {
    blocks.push({
      x: 0,
      y: prevEnd,
      w: cols,
      h: rows - prevEnd,
      type: 'text',
    });
  }

  logger.debug(`[OpenCV] Segmented ${blocks.length} message blocks from ${rows}x${cols} image`);

  return blocks;
}

/**
 * Refine block boundaries using vertical projection within each block
 */
export function refineBlockBoundaries(img: cv.Mat, block: MessageBlock): MessageBlock[] {
  const roi = img.getRegion(
    new cv.Rect(block.x, block.y, block.w, block.h)
  );

  const gray = roi.bgrToGray();
  const blurred = gray.gaussianBlur(new cv.Size(3, 3), 0);
  const binary = blurred.threshold(0, 255, cv.THRESH_OTSU);

  const rows = binary.rows;
  const cols = binary.cols;

  // Vertical projection (count black pixels per column)
  const proj = new Array(cols).fill(0);
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) {
      if (binary.at(y, x) === 0) {
        proj[x]++;
      }
    }
  }

  // Find left and right boundaries (where projection goes from 0 to non-zero)
  let leftBound = 0;
  let rightBound = cols - 1;

  // Find left boundary (first column with significant content)
  for (let x = 0; x < cols; x++) {
    if (proj[x] > rows * 0.05) {
      leftBound = Math.max(0, x - 5);
      break;
    }
  }

  // Find right boundary (last column with significant content)
  for (let x = cols - 1; x >= 0; x--) {
    if (proj[x] > rows * 0.05) {
      rightBound = Math.min(cols - 1, x + 5);
      break;
    }
  }

  return [
    {
      ...block,
      x: block.x + leftBound,
      y: block.y,
      w: rightBound - leftBound + 1,
      h: block.h,
    },
  ];
}

/**
 * Detect if a region is likely an image based on edge density
 * WeChat images have no special marker - they appear as photo thumbnails
 */
export function isImageRegion(img: cv.Mat): boolean {
  // Apply Canny edge detection
  const edges = img.canny(100, 200);

  // Calculate edge density
  const edgePixels = edges.countNonZero();
  const totalPixels = img.rows * img.cols;
  const edgeDensity = edgePixels / totalPixels;

  // Image regions typically have higher edge density than text
  // Text has ~0.02-0.04, images have ~0.06+
  // But images without markers have variable density, so we use a lower threshold
  logger.debug(`[OpenCV] Edge density: ${edgeDensity.toFixed(4)}`);

  // Additional check: images usually have reasonable size
  const areaRatio = totalPixels / (1920 * 1080); // relative to 1080p

  // Image if: edge density > 4% AND region is reasonably large (> 0.5% of 1080p screen)
  return edgeDensity > 0.04 && areaRatio > 0.005;
}

/**
 * Detect if a region is likely a file attachment based on icon patterns
 * WeChat file messages have distinctive colored icons:
 * - Excel: green icon with white "X"
 * - PDF: red icon with "PDF" text
 * - Word: blue icon
 */
export function isFileRegion(img: cv.Mat): boolean {
  // Method 1: Detect file icon colors (green=Excel, red=PDF, blue=Word)
  const fileColor = detectFileIconColor(img);

  // Method 2: Look for rectangular contours (document shape)
  const gray = img.bgrToGray();
  const edges = gray.canny(50, 150);
  const contours = edges.findContours(cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  let rectangularCount = 0;
  for (const contour of contours) {
    const approx = contour.approxPolyDP(0.04 * contour.arcLength());
    if (approx.length === 4) {
      rectangularCount++;
    }
  }

  // File icons typically have 1-3 rectangular elements
  const hasRectangles = rectangularCount >= 1 && rectangularCount <= 3;

  // Either file color OR rectangles could indicate a file
  return fileColor !== null || hasRectangles;
}

/**
 * Detect file icon colors characteristic of WeChat file attachments
 * Different file types have different colors:
 * - Excel: green (hue 35-85)
 * - PDF: red/orange (hue 0-30 or 150-180)
 * - Word: blue (hue 90-130)
 */
function detectFileIconColor(img: cv.Mat): 'excel' | 'pdf' | 'word' | null {
  const hsv = img.cvtColor(cv.COLOR_BGR2HSV);

  // Check for each color type
  const colors = [
    { name: 'excel' as const, lower: new cv.Vec3(35, 50, 50), upper: new cv.Vec3(85, 255, 255) },
    { name: 'red' as const, lower: new cv.Vec3(0, 50, 50), upper: new cv.Vec3(15, 255, 255) },
    { name: 'red2' as const, lower: new cv.Vec3(160, 50, 50), upper: new cv.Vec3(180, 255, 255) },
    { name: 'word' as const, lower: new cv.Vec3(90, 40, 40), upper: new cv.Vec3(130, 255, 255) },
  ];

  let bestMatch: 'excel' | 'pdf' | 'word' | null = null;
  let bestRatio = 0;

  for (const color of colors) {
    const mask = hsv.inRange(color.lower, color.upper);
    const coloredPixels = mask.countNonZero();
    const ratio = coloredPixels / (img.rows * img.cols);
    mask.delete();

    if (ratio > 0.01 && ratio > bestRatio) {
      bestRatio = ratio;
      if (color.name === 'excel') bestMatch = 'excel';
      else if (color.name === 'red' || color.name === 'red2') bestMatch = 'pdf';
      else if (color.name === 'word') bestMatch = 'word';
    }
  }

  hsv.delete();
  return bestMatch;
}

// Keep alias for backward compatibility
function detectGreenColor(img: cv.Mat): boolean {
  return detectFileIconColor(img) !== null;
}

/**
 * Template matching to find attachment icons
 */
export function matchTemplate(
  baseImg: cv.Mat,
  template: cv.Mat,
  threshold: number = 0.7
): TemplateMatchResult | null {
  if (baseImg.rows < template.rows || baseImg.cols < template.cols) {
    return null;
  }

  const result = baseImg.matchTemplate(template, cv.TM_CCOEFF_NORMED);
  const { maxVal, maxLoc } = result.minMaxLoc();

  if (maxVal >= threshold) {
    return {
      x: maxLoc.x,
      y: maxLoc.y,
      w: template.cols,
      h: template.rows,
      score: maxVal,
    };
  }

  return null;
}

/**
 * Find all matches of a template in an image
 */
export function findAllTemplateMatches(
  baseImg: cv.Mat,
  template: cv.Mat,
  threshold: number = 0.7,
  maxMatches: number = 10
): TemplateMatchResult[] {
  const matches: TemplateMatchResult[] = [];

  if (baseImg.rows < template.rows || baseImg.cols < template.cols) {
    return matches;
  }

  let searchImg = baseImg.clone();
  let searchMask = cv.Mat.zeros(baseImg.rows, baseImg.cols, cv.CV_8UC1);

  for (let i = 0; i < maxMatches; i++) {
    const result = searchImg.matchTemplate(template, cv.TM_CCOEFF_NORMED);
    const { maxVal, maxLoc } = result.minMaxLoc();

    if (maxVal < threshold) {
      break;
    }

    matches.push({
      x: maxLoc.x,
      y: maxLoc.y,
      w: template.cols,
      h: template.rows,
      score: maxVal,
    });

    // Mask out this match to find next one
    const maskRect = new cv.Rect(
      Math.max(0, maxLoc.x - template.cols / 2),
      Math.max(0, maxLoc.y - template.rows / 2),
      Math.min(template.cols * 2, baseImg.cols - maxLoc.x),
      Math.min(template.rows * 2, baseImg.rows - maxLoc.y)
    );
    searchMask
      .getRegion(maskRect)
      .setTo(0);
  }

  return matches;
}

/**
 * Crop region from image
 */
export function cropRegion(img: cv.Mat, block: MessageBlock): cv.Mat {
  return img.getRegion(
    new cv.Rect(block.x, block.y, block.w, block.h)
  );
}

/**
 * Convert OpenCV mat to base64 for VLM processing
 */
export function matToBase64(mat: cv.Mat, format: 'jpg' | 'png' = 'jpg'): string {
  const buffer = mat.toBuffer(format);
  return buffer.toString('base64');
}

/**
 * Convert base64 to OpenCV mat
 */
export function base64ToMat(base64: string): cv.Mat {
  const buffer = Buffer.from(base64, 'base64');
  return cv.imdecode(buffer);
}

/**
 * Load image file to OpenCV mat
 */
export function loadImage(imagePath: string): cv.Mat {
  const img = cv.imread(imagePath);
  if (img.empty) {
    throw new Error(`Failed to load image: ${imagePath}`);
  }
  return img;
}

/**
 * Save OpenCV mat to file
 */
export function saveImage(mat: cv.Mat, imagePath: string): void {
  cv.imwrite(imagePath, mat);
}

/**
 * Resize image while maintaining aspect ratio
 */
export function resizeImage(
  mat: cv.Mat,
  maxWidth: number,
  maxHeight: number
): cv.Mat {
  const ratio = Math.min(maxWidth / mat.cols, maxHeight / mat.rows);
  if (ratio >= 1) {
    return mat;
  }
  const newWidth = Math.round(mat.cols * ratio);
  const newHeight = Math.round(mat.rows * ratio);
  return mat.resize(newHeight, newWidth);
}

/**
 * Preprocess image for better OCR results
 */
export function preprocessForOCR(mat: cv.Mat): cv.Mat {
  // Convert to grayscale
  let gray = mat.bgrToGray();

  // Apply adaptive thresholding for better text extraction
  gray = gray.adaptiveThreshold(
    255,
    cv.ADAPTIVE_THRESH_GAUSSIAN_C,
    cv.THRESH_BINARY,
    11,
    2
  );

  return gray;
}

/**
 * Detect message type for each block
 */
export function detectBlockType(img: cv.Mat, block: MessageBlock): MessageBlock {
  const crop = cropRegion(img, block);

  // Check for image characteristics
  const isImg = isImageRegion(crop);

  // Check for file characteristics
  const isFile = isFileRegion(crop);

  let type: MessageBlock['type'] = 'text';
  if (isImg && isFile) {
    type = 'mixed';
  } else if (isImg) {
    type = 'image';
  } else if (isFile) {
    type = 'file';
  }

  return {
    ...block,
    type,
    crop,
  };
}

/**
 * Full pipeline: segment, refine, and classify message blocks
 */
export function processScreenshot(imagePath: string): SegmentResult {
  logger.info(`[OpenCV] Processing screenshot: ${imagePath}`);

  const img = loadImage(imagePath);
  logger.debug(`[OpenCV] Image loaded: ${img.cols}x${img.rows}`);

  // Segment into message strips
  let blocks = segmentMessageStrips(img);

  // Refine boundaries
  blocks = blocks.flatMap((block) => refineBlockBoundaries(img, block));

  // Detect type for each block
  blocks = blocks.map((block) => detectBlockType(img, block));

  logger.info(`[OpenCV] Found ${blocks.length} message blocks`);

  // Log type distribution
  const typeCount = blocks.reduce((acc, b) => {
    acc[b.type] = (acc[b.type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  logger.debug(`[OpenCV] Block types: ${JSON.stringify(typeCount)}`);

  return { blocks, image: img };
}

/**
 * Clean up OpenCV resources
 */
export function disposeImage(img: cv.Mat): void {
  img.delete();
}
