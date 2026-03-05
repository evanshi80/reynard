/**
 * Vision Processor using Sharp (instead of OpenCV)
 *
 * This module provides equivalent functionality to opencvProcessor.ts
 * using Sharp for image processing.
 *
 * Functions implemented:
 * - Message strip segmentation (horizontal projection)
 * - Color-based file icon detection
 * - Image region detection (edge density)
 * - Video detection (play button pattern)
 */
import sharp from 'sharp';
import { logger } from '../utils/logger.js';
import path from 'path';
import fs from 'fs';

export interface MessageBlock {
  x: number;
  y: number;
  w: number;
  h: number;
  type: 'text' | 'image' | 'file' | 'video' | 'mixed';
}

export interface SegmentResult {
  blocks: MessageBlock[];
}

export interface TemplateMatchResult {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

export type FileType = 'excel' | 'pdf' | 'word' | 'ppt' | 'zip' | 'txt';

/**
 * Load image and get pixel data
 */
async function getImageData(imagePath: string): Promise<{
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}> {
  const img = sharp(imagePath);
  const metadata = await img.metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  const channels = metadata.channels || 3;

  // Get raw pixel data (RGB)
  const { data, info } = await img
    .raw()
    .toBuffer({ resolveWithObject: true });

  return { data, width: info.width, height: info.height, channels: info.channels };
}

/**
 * Get pixel at position
 */
function getPixel(data: Buffer, width: number, x: number, y: number, channels: number): { r: number; g: number; b: number } | null {
  if (x < 0 || y < 0 || x >= width) return null;
  const idx = (y * width + x) * channels;
  return {
    r: data[idx],
    g: data[idx + 1],
    b: data[idx + 2],
  };
}

/**
 * Convert RGB to HSV
 */
function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  r /= 255;
  g /= 255;
  b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const diff = max - min;

  let h = 0;
  if (diff !== 0) {
    if (max === r) h = ((g - b) / diff) % 6;
    else if (max === g) h = (b - r) / diff + 2;
    else h = (r - g) / diff + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  const s = max === 0 ? 0 : diff / max;
  const v = max;

  return { h, s, v };
}

/**
 * Calculate horizontal projection (count dark pixels per row)
 */
function calculateHorizontalProjection(data: Buffer, width: number, height: number, channels: number): number[] {
  const proj = new Array(height).fill(0);
  const threshold = 128; // Consider pixel dark if brightness < 50%

  for (let y = 0; y < height; y++) {
    let darkPixels = 0;
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const brightness = (r + g + b) / 3;

      if (brightness < threshold) {
        darkPixels++;
      }
    }
    proj[y] = darkPixels;
  }

  return proj;
}

/**
 * Segment message strips from chat screenshot using horizontal projection
 */
export async function segmentMessageStrips(imagePath: string): Promise<MessageBlock[]> {
  logger.info(`[Sharp] Segmenting: ${imagePath}`);

  const { data, width, height, channels } = await getImageData(imagePath);

  // Calculate horizontal projection
  const proj = calculateHorizontalProjection(data, width, height, channels);

  // Find horizontal gap segments (blank rows between messages)
  // Threshold: row has less than 3% dark pixels = blank
  const blankThreshold = width * 0.03;
  const minGapHeight = 8;

  const gaps: { start: number; end: number }[] = [];
  let runningStart: number | null = null;

  for (let y = 0; y < height; y++) {
    if (proj[y] < blankThreshold) {
      if (runningStart === null) runningStart = y;
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

  if (runningStart !== null && height - runningStart >= minGapHeight) {
    gaps.push({ start: runningStart, end: height });
  }

  // Extract blocks between gaps
  const blocks: MessageBlock[] = [];
  let prevEnd = 0;

  for (const gap of gaps) {
    if (gap.start - prevEnd > 20) {
      blocks.push({
        x: 0,
        y: prevEnd,
        w: width,
        h: gap.start - prevEnd,
        type: 'text',
      });
    }
    prevEnd = gap.end;
  }

  if (prevEnd < height - 20) {
    blocks.push({
      x: 0,
      y: prevEnd,
      w: width,
      h: height - prevEnd,
      type: 'text',
    });
  }

  logger.info(`[Sharp] Found ${blocks.length} message blocks`);

  return blocks;
}

/**
 * Detect file icon colors in a region
 * WeChat file icons: Excel=green, PDF=red, Word=blue, PPT=orange, ZIP=yellow, TXT=gray
 */
function detectFileIconColorInRegion(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  block: MessageBlock
): FileType | null {
  // Define color ranges in HSV
  const colorRanges = [
    { name: 'excel' as FileType, hMin: 35, hMax: 85, sMin: 50, vMin: 50 },
    { name: 'pdf' as FileType, hMin: 0, hMax: 15, sMin: 50, vMin: 50 },
    { name: 'pdf2' as FileType, hMin: 160, hMax: 180, sMin: 50, vMin: 50 },
    { name: 'word' as FileType, hMin: 90, hMax: 130, sMin: 40, vMin: 40 },
    { name: 'ppt' as FileType, hMin: 10, hMax: 40, sMin: 60, vMin: 60 },
    { name: 'zip' as FileType, hMin: 15, hMax: 50, sMin: 70, vMin: 70 },
  ];

  let bestMatch: FileType | null = null;
  let bestRatio = 0;
  const colorCounts: Record<FileType, number> = {
    excel: 0, pdf: 0, word: 0, ppt: 0, zip: 0, txt: 0
  };
  let totalPixels = 0;

  // Sample every 4th pixel for performance
  for (let y = Math.floor(block.y); y < Math.min(block.y + block.h, height); y += 4) {
    for (let x = Math.floor(block.x); x < Math.min(block.x + block.w, width); x += 4) {
      const idx = (y * width + x) * channels;
      const { r, g, b } = { r: data[idx], g: data[idx + 1], b: data[idx + 2] };
      const { h, s, v } = rgbToHsv(r, g, b);

      totalPixels++;

      for (const color of colorRanges) {
        if (h >= color.hMin && h <= color.hMax && s >= color.sMin / 100 && v >= color.vMin / 100) {
          colorCounts[color.name]++;
        }
      }
    }
  }

  if (totalPixels === 0) return null;

  for (const [name, count] of Object.entries(colorCounts)) {
    const ratio = count / totalPixels;
    if (ratio > 0.01 && ratio > bestRatio) {
      bestRatio = ratio;
      bestMatch = name as FileType;
    }
  }

  return bestMatch;
}

/**
 * Calculate edge density using simple gradient
 */
function calculateEdgeDensity(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  block: MessageBlock
): number {
  let edgePixels = 0;
  let totalPixels = 0;

  const blockX = Math.floor(block.x);
  const blockY = Math.floor(block.y);
  const blockW = Math.floor(block.w);
  const blockH = Math.floor(block.h);

  for (let y = blockY + 1; y < Math.min(blockY + blockH - 1, height - 1); y++) {
    for (let x = blockX + 1; x < Math.min(blockX + blockW - 1, width - 1); x += 2) {
      const idx = (y * width + x) * channels;
      const idxRight = idx + channels;
      const idxDown = ((y + 1) * width + x) * channels;

      // Simple gradient: difference with right and down neighbors
      const gx = Math.abs(data[idx] - data[idxRight]) + Math.abs(data[idx + 1] - data[idxRight + 1]) + Math.abs(data[idx + 2] - data[idxRight + 2]);
      const gy = Math.abs(data[idx] - data[idxDown]) + Math.abs(data[idx + 1] - data[idxDown + 1]) + Math.abs(data[idx + 2] - data[idxDown + 2]);

      const gradient = (gx + gy) / 3;
      if (gradient > 30) edgePixels++;
      totalPixels++;
    }
  }

  return totalPixels > 0 ? edgePixels / totalPixels : 0;
}

/**
 * Detect if a region is likely an image
 */
function isImageRegion(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  block: MessageBlock
): boolean {
  const edgeDensity = calculateEdgeDensity(data, width, height, channels, block);
  const areaRatio = (block.w * block.h) / (width * height);

  logger.debug(`[Sharp] Block ${block.y}: edgeDensity=${edgeDensity.toFixed(4)}, areaRatio=${areaRatio.toFixed(4)}`);

  // Image: higher edge density + reasonable size
  return edgeDensity > 0.04 && areaRatio > 0.005;
}

/**
 * Detect if a region is likely a file
 */
function isFileRegion(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  block: MessageBlock
): boolean {
  const fileColor = detectFileIconColorInRegion(data, width, height, channels, block);
  return fileColor !== null;
}

/**
 * Detect if a region is likely a video (center play button)
 */
function isVideoRegion(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  block: MessageBlock
): boolean {
  // Check center region for play button pattern (triangle)
  const centerX = Math.floor(block.x + block.w * 0.25);
  const centerY = Math.floor(block.y + block.h * 0.25);
  const centerW = Math.floor(block.w * 0.5);
  const centerH = Math.floor(block.h * 0.5);

  // Look for lighter region in center (play button)
  let lightPixels = 0;
  let totalCenterPixels = 0;

  for (let y = centerY; y < centerY + centerH && y < height; y += 2) {
    for (let x = centerX; x < centerX + centerW && x < width; x += 2) {
      const idx = (y * width + x) * channels;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const brightness = (r + g + b) / 3;

      if (brightness > 200) lightPixels++;
      totalCenterPixels++;
    }
  }

  // If center has light pixels (play button), likely a video
  const lightRatio = totalCenterPixels > 0 ? lightPixels / totalCenterPixels : 0;

  // Also check bottom-right for duration text
  const durationX = Math.floor(block.x + block.w * 0.7);
  const durationY = Math.floor(block.y + block.h * 0.7);
  const durationW = Math.floor(block.w * 0.3);
  const durationH = Math.floor(block.h * 0.3);

  let durationEdges = 0;
  let durationTotal = 0;

  for (let y = durationY; y < durationY + durationH && y < height - 1; y += 2) {
    for (let x = durationX; x < durationX + durationW && x < width - 1; x += 2) {
      const idx = (y * width + x) * channels;
      const idxRight = idx + channels;
      const idxDown = ((y + 1) * width + x) * channels;

      const diff = Math.abs(data[idx] - data[idxRight]) + Math.abs(data[idx + 1] - data[idxRight + 1]) + Math.abs(data[idx + 2] - data[idxRight + 2]);
      if (diff > 20) durationEdges++;
      durationTotal++;
    }
  }

  const durationRatio = durationTotal > 0 ? durationEdges / durationTotal : 0;

  // Video if: has light center (play button) OR center circle + duration
  return lightRatio > 0.05 || (lightRatio > 0.02 && durationRatio > 0.1);
}

/**
 * Full pipeline: segment and classify message blocks
 */
export async function processScreenshot(imagePath: string): Promise<SegmentResult> {
  logger.info(`[Sharp] Processing screenshot: ${imagePath}`);

  // First segment into blocks
  const blocks = await segmentMessageStrips(imagePath);

  // Then classify each block
  const { data, width, height, channels } = await getImageData(imagePath);

  for (const block of blocks) {
    // Priority: video > file > image > text
    if (isVideoRegion(data, width, height, channels, block)) {
      block.type = 'video';
    } else if (isFileRegion(data, width, height, channels, block)) {
      block.type = 'file';
    } else if (isImageRegion(data, width, height, channels, block)) {
      block.type = 'image';
    } else {
      block.type = 'text';
    }

    logger.debug(`[Sharp] Block y=${block.y}: type=${block.type}`);
  }

  // Log type distribution
  const typeCount = blocks.reduce((acc, b) => {
    acc[b.type] = (acc[b.type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  logger.info(`[Sharp] Block types: ${JSON.stringify(typeCount)}`);

  return { blocks };
}

/**
 * Crop a region from image and save to file
 */
export async function cropBlock(
  imagePath: string,
  block: MessageBlock,
  outputPath: string
): Promise<void> {
  await sharp(imagePath)
    .extract({
      left: Math.floor(block.x),
      top: Math.floor(block.y),
      width: Math.floor(block.w),
      height: Math.floor(block.h),
    })
    .toFile(outputPath);
}

/**
 * Resize image for VLM processing
 */
export async function resizeForVLM(imagePath: string, maxWidth: number = 1024): Promise<Buffer> {
  return sharp(imagePath)
    .resize(maxWidth, null, { fit: 'inside' })
    .jpeg({ quality: 85 })
    .toBuffer();
}

/**
 * Convert image to base64 for VLM
 */
export async function imageToBase64(imagePath: string): Promise<string> {
  const buffer = await sharp(imagePath).jpeg({ quality: 85 }).toBuffer();
  return buffer.toString('base64');
}
