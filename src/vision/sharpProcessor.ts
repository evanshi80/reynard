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
 * Estimate chat background color by sampling sparse pixels.
 * Keep it simple: average RGB from areas likely to be background.
 */
function estimateBackgroundRgb(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  skipTop: number
): { r: number; g: number; b: number } {
  // Sample a few vertical bands in the "empty" middle area
  const xs = [
    Math.floor(width * 0.25),
    Math.floor(width * 0.5),
    Math.floor(width * 0.75),
  ];
  const yStart = Math.min(height - 1, skipTop + 20);
  const yEnd = Math.min(height - 1, yStart + Math.floor(height * 0.35));

  let sr = 0, sg = 0, sb = 0, n = 0;

  for (let y = yStart; y < yEnd; y += 20) {
    for (const x of xs) {
      const idx = (y * width + x) * channels;
      if (idx + 2 >= data.length) continue;
      sr += data[idx];
      sg += data[idx + 1];
      sb += data[idx + 2];
      n++;
    }
  }

  if (n === 0) return { r: 240, g: 240, b: 240 };
  return { r: Math.round(sr / n), g: Math.round(sg / n), b: Math.round(sb / n) };
}

function colorDist(a: { r: number; g: number; b: number }, r: number, g: number, b: number): number {
  // Manhattan distance is fast and good enough here
  return Math.abs(a.r - r) + Math.abs(a.g - g) + Math.abs(a.b - b);
}

/**
 * Estimate saturation ratio for entire block
 * Text bubbles (high saturation) vs file cards (low saturation background)
 * Returns ratio of pixels with saturation > 30%
 */
function estimateSaturationRatio(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  block: MessageBlock
): number {
  const blockX = Math.floor(block.x);
  const blockY = Math.floor(block.y);
  const blockW = Math.floor(block.w);
  const blockH = Math.floor(block.h);

  let saturatedPixels = 0;
  let totalPixels = 0;

  for (let y = blockY; y < Math.min(blockY + blockH, height); y += 2) {
    for (let x = blockX; x < Math.min(blockX + blockW, width); x += 2) {
      const idx = (y * width + x) * channels;
      if (idx + 2 >= data.length) continue;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const { s } = rgbToHsv(r, g, b);
      if (s > 0.3) saturatedPixels++;
      totalPixels++;
    }
  }

  return totalPixels > 0 ? saturatedPixels / totalPixels : 0;
}

/**
 * Find bounding box of saturated pixels in a region
 * Used to verify file icon is a compact cluster (not scattered)
 * Returns {x, y, w, h} of saturated pixel cluster or null if too sparse
 */
function findSaturatedBBox(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  iconX: number,
  iconY: number,
  iconW: number,
  iconH: number
): { x: number; y: number; w: number; h: number } | null {
  // Find min/max of saturated pixels
  let minX = iconX + iconW;
  let maxX = iconX;
  let minY = iconY + iconH;
  let maxY = iconY;
  let saturatedCount = 0;

  for (let y = iconY; y < Math.min(iconY + iconH, height); y += 1) {
    for (let x = iconX; x < Math.min(iconX + iconW, width); x += 1) {
      const idx = (y * width + x) * channels;
      if (idx + 2 >= data.length) continue;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const { s } = rgbToHsv(r, g, b);

      if (s > 0.3) {
        saturatedCount++;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (saturatedCount < 2) return null;

  const bboxW = maxX - minX + 1;
  const bboxH = maxY - minY + 1;

  // Gate 1: check if saturated cluster is square-ish (aspect ratio 0.6-1.6)
  const aspectRatio = bboxW / Math.max(bboxH, 1);
  if (aspectRatio < 0.6 || aspectRatio > 1.6) {
    return null;
  }

  return { x: minX, y: minY, w: bboxW, h: bboxH };
}

/**
 * Horizontal projection based on "non-background" pixels.
 * This is more robust for WeChat (light background, colored bubbles).
 */
function calculateHorizontalProjectionNonBg(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  bg: { r: number; g: number; b: number },
  options?: { xStep?: number; yStep?: number; distThreshold?: number }
): number[] {
  const xStep = options?.xStep ?? 3;
  const yStep = options?.yStep ?? 1;
  const distThreshold = options?.distThreshold ?? 35;

  const proj = new Array(height).fill(0);

  for (let y = 0; y < height; y += yStep) {
    let nonBg = 0;

    for (let x = 0; x < width; x += xStep) {
      const idx = (y * width + x) * channels;
      if (idx + 2 >= data.length) continue;

      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];

      if (colorDist(bg, r, g, b) >= distThreshold) nonBg++;
    }

    proj[y] = nonBg;
  }

  return proj;
}

/**
 * Calculate horizontal projection (count dark pixels per row) - DEPRECATED
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
 * Find avatar positions in the chat area
 * Avatars are circular/square regions with consistent size on left or right edge
 */
function findAvatarPositions(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  startY: number,
  endY: number
): Array<{ x: number; y: number; side: 'left' | 'right' }> {
  const avatars: Array<{ x: number; y: number; side: 'left' | 'right' }> = [];

  // Avatar is typically around 40-60 pixels from left or right edge
  const avatarSize = 50;
  const avatarSpacing = 80; // Expected vertical spacing between avatars

  // Find avatars on LEFT side (x: 20-80)
  for (let y = startY; y < endY; y += 10) {
    // Check for avatar-like region: square, skin-tone or colorful
    let skinPixels = 0;
    let totalCheck = 0;

    for (let dy = 0; dy < avatarSize && y + dy < height; dy += 2) {
      for (let dx = 0; dx < 30 && dx < width; dx += 2) {
        const idx = ((y + dy) * width + (30 + dx)) * channels;
        if (idx + 2 >= data.length) continue;

        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        // Simple skin tone detection (reddish)
        if (r > 100 && g > 80 && b > 80 && r > g && r > b) {
          skinPixels++;
        }
        totalCheck++;
      }
    }

    // If skin-like pixels found in avatar position
    if (skinPixels > totalCheck * 0.1) {
      // Check if this is a new avatar (not too close to previous)
      const lastAvatar = avatars[avatars.length - 1];
      if (!lastAvatar || y - lastAvatar.y > avatarSpacing * 0.7) {
        avatars.push({ x: 35, y: y + 15, side: 'left' });
      }
    }
  }

  // Find avatars on RIGHT side (x: width - 80 to width - 30)
  for (let y = startY; y < endY; y += 10) {
    let skinPixels = 0;
    let totalCheck = 0;

    for (let dy = 0; dy < avatarSize && y + dy < height; dy += 2) {
      for (let dx = 0; dx < 30 && (width - 60 + dx) < width; dx += 2) {
        const idx = ((y + dy) * width + (width - 60 + dx)) * channels;
        if (idx + 2 >= data.length) continue;

        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        if (r > 100 && g > 80 && b > 80 && r > g && r > b) {
          skinPixels++;
        }
        totalCheck++;
      }
    }

    if (skinPixels > totalCheck * 0.1) {
      const lastAvatar = avatars[avatars.length - 1];
      if (!lastAvatar || y - lastAvatar.y > avatarSpacing * 0.7) {
        avatars.push({ x: width - 65, y: y + 15, side: 'right' });
      }
    }
  }

  return avatars;
}

/**
 * Segment message strips from chat screenshot using avatar-based detection
 * This is more reliable than horizontal projection
 */
export async function segmentByAvatars(imagePath: string): Promise<MessageBlock[]> {
  const { data, width, height, channels } = await getImageData(imagePath);

  logger.info(`[Sharp] Segmenting by avatars: ${width}x${height}`);

  // Find avatars in chat area (skip header ~100px)
  const avatars = findAvatarPositions(data, width, height, channels, 100, height);

  logger.info(`[Sharp] Found ${avatars.length} avatars`);

  if (avatars.length < 2) {
    // Fallback to horizontal projection
    logger.info('[Sharp] Falling back to horizontal projection');
    return segmentMessageStrips(imagePath);
  }

  // Sort avatars by Y position
  avatars.sort((a, b) => a.y - b.y);

  // Create blocks between consecutive avatars
  const blocks: MessageBlock[] = [];

  for (let i = 0; i < avatars.length; i++) {
    const currentAvatar = avatars[i];
    const nextAvatar = avatars[i + 1];

    const blockTop = currentAvatar.y;
    const blockBottom = nextAvatar ? nextAvatar.y : height;

    // Skip if block is too small
    if (blockBottom - blockTop < 30) continue;

    // Determine block bounds based on avatar side
    let blockX: number;
    let blockW: number;

    if (currentAvatar.side === 'left') {
      // Left avatar: message extends to right (from avatar to ~80% of width)
      blockX = currentAvatar.x + 50;
      blockW = Math.min(width * 0.65, width - blockX - 20);
    } else {
      // Right avatar: message extends to left (from avatar to left side)
      blockX = 20;
      blockW = currentAvatar.x - 30 - blockX;
    }

    blocks.push({
      x: blockX,
      y: blockTop,
      w: Math.max(100, blockW),
      h: blockBottom - blockTop,
      type: 'text',
    });
  }

  logger.info(`[Sharp] Created ${blocks.length} blocks from avatars`);

  return blocks;
}

/**
 * Detect actual horizontal bounds based on content
 */
function findHorizontalBoundsSimple(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  bg: { r: number; g: number; b: number },
  rowStart: number,
  rowEnd: number,
  avatarSide: 'left' | 'right'
): { x: number; w: number } {
  const distThreshold = 80;
  const sampleStep = 4;

  if (avatarSide === 'left') {
    // Scan from left (after avatar) to find start
    let contentStart = 80;
    for (let x = 80; x < width - 50; x += sampleStep) {
      let hasContent = false;
      for (let y = rowStart; y < rowEnd; y += sampleStep) {
        const idx = (y * width + x) * channels;
        if (idx + 2 >= data.length) continue;
        if (colorDist(bg, data[idx], data[idx + 1], data[idx + 2]) >= distThreshold) {
          hasContent = true;
          break;
        }
      }
      if (hasContent) {
        contentStart = x;
        break;
      }
    }

    // Scan from right to find end
    let contentEnd = width - 80;
    for (let x = width - 80; x > contentStart; x -= sampleStep) {
      let hasContent = false;
      for (let y = rowStart; y < rowEnd; y += sampleStep) {
        const idx = (y * width + x) * channels;
        if (idx + 2 >= data.length) continue;
        if (colorDist(bg, data[idx], data[idx + 1], data[idx + 2]) >= distThreshold) {
          hasContent = true;
          break;
        }
      }
      if (hasContent) {
        contentEnd = x;
        break;
      }
    }

    return { x: contentStart, w: Math.max(100, contentEnd - contentStart + 1) };
  } else {
    // Right side: scan from right to find end
    let contentEnd = width - 80;
    for (let x = width - 80; x > 50; x -= sampleStep) {
      let hasContent = false;
      for (let y = rowStart; y < rowEnd; y += sampleStep) {
        const idx = (y * width + x) * channels;
        if (idx + 2 >= data.length) continue;
        if (colorDist(bg, data[idx], data[idx + 1], data[idx + 2]) >= distThreshold) {
          hasContent = true;
          break;
        }
      }
      if (hasContent) {
        contentEnd = x;
        break;
      }
    }

    // Scan from left to find start
    let contentStart = 80;
    for (let x = 80; x < contentEnd; x += sampleStep) {
      let hasContent = false;
      for (let y = rowStart; y < rowEnd; y += sampleStep) {
        const idx = (y * width + x) * channels;
        if (idx + 2 >= data.length) continue;
        if (colorDist(bg, data[idx], data[idx + 1], data[idx + 2]) >= distThreshold) {
          hasContent = true;
          break;
        }
      }
      if (hasContent) {
        contentStart = x;
        break;
      }
    }

    return { x: contentStart, w: Math.max(100, contentEnd - contentStart + 1) };
  }
}

/**
 * Detect if content is on left or right side
 * Simplified: check if there's significant content near left edge vs right edge
 */
function detectContentSide(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  bg: { r: number; g: number; b: number },
  rowStart: number,
  rowEnd: number
): 'left' | 'right' {
  let leftEdge = 0;  // Content near left edge (x < 120)
  let rightEdge = 0; // Content near right edge (x > width - 120)
  const sampleStep = 3;
  const distThreshold = 80;
  const edgeThreshold = 120;

  for (let y = rowStart; y < rowEnd; y += sampleStep) {
    // Check left edge region
    for (let x = 50; x < edgeThreshold; x += sampleStep) {
      const idx = (y * width + x) * channels;
      if (idx + 2 >= data.length) continue;
      if (colorDist(bg, data[idx], data[idx + 1], data[idx + 2]) >= distThreshold) {
        leftEdge++;
      }
    }
    // Check right edge region
    for (let x = width - edgeThreshold; x < width - 50; x += sampleStep) {
      const idx = (y * width + x) * channels;
      if (idx + 2 >= data.length) continue;
      if (colorDist(bg, data[idx], data[idx + 1], data[idx + 2]) >= distThreshold) {
        rightEdge++;
      }
    }
  }

  // If there's more content near left edge, it's a left-side message
  return leftEdge > rightEdge ? 'left' : 'right';
}

/**
 * Segment message strips from chat screenshot using non-background projection
 * with precise X coordinate detection
 */
export async function segmentMessageStrips(imagePath: string): Promise<MessageBlock[]> {
  logger.info(`[Sharp] Segmenting: ${imagePath}`);

  const { data, width, height, channels } = await getImageData(imagePath);

  // Skip header area
  const skipTop = 100;

  // Estimate background color
  const bg = estimateBackgroundRgb(data, width, height, channels, skipTop);
  logger.debug(`[Sharp] Background color: RGB(${bg.r}, ${bg.g}, ${bg.b})`);

  // Determine if dark theme (background is dark)
  const bgBrightness = (bg.r + bg.g + bg.b) / 3;
  const isDarkTheme = bgBrightness < 80;
  // Use smaller threshold for dark theme where bubble colors are similar to background
  const distThreshold = isDarkTheme ? 50 : 80;

  // Calculate non-background horizontal projection
  const proj = calculateHorizontalProjectionNonBg(data, width, height, channels, bg, {
    xStep: 3,
    distThreshold,
  });

  // Content threshold
  const maxSamplesPerRow = Math.floor(width / 3);
  const contentThreshold = Math.max(8, Math.floor(maxSamplesPerRow * 0.03));

  // Find continuous "content runs"
  const runs: Array<{ start: number; end: number }> = [];
  let runStart: number | null = null;

  for (let y = skipTop; y < height; y++) {
    const hasContent = proj[y] >= contentThreshold;

    if (hasContent) {
      if (runStart === null) runStart = y;
    } else {
      if (runStart !== null) {
        const runH = y - runStart;
        if (runH >= 18) runs.push({ start: runStart, end: y });
        runStart = null;
      }
    }
  }
  if (runStart !== null && height - runStart >= 18) runs.push({ start: runStart, end: height });

  // Merge nearby runs
  const merged: Array<{ start: number; end: number }> = [];
  const mergeGap = 10;

  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (!last) merged.push({ ...r });
    else if (r.start - last.end <= mergeGap) last.end = r.end;
    else merged.push({ ...r });
  }

  // Filter out time separators
  const filtered = merged.filter(r => {
    const h = r.end - r.start;
    return h >= 20 || h >= 25;
  });

  // Convert to blocks with precise X coordinates
  const blocks: MessageBlock[] = filtered.map(r => {
    // Detect if content is on left or right
    const side = detectContentSide(data, width, height, channels, bg, r.start, r.end);

    // Find horizontal bounds
    const bounds = findHorizontalBoundsSimple(data, width, height, channels, bg, r.start, r.end, side);

    // For left-side messages, add offset to skip nickname area
    const yOffset = 0;

    return {
      x: bounds.x,
      y: r.start + yOffset,
      w: bounds.w,
      h: r.end - r.start - yOffset,
      type: 'text',
    };
  });

  logger.info(`[Sharp] Found ${blocks.length} message blocks (non-bg projection)`);

  return blocks;
}

/**
 * Trim group-chat nickname line from the top of a message block.
 * Heuristic: a thin, low-saturation, non-bubble text line at the top.
 */
function trimGroupNicknameLine(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  bg: { r: number; g: number; b: number },
  block: MessageBlock
): MessageBlock {
  // Only worth trying on reasonably tall blocks
  if (block.h < 60) return block;

  // 1) Build a non-bg projection inside the block
  const xStep = 3;
  const distThreshold = 60;
  const proj: number[] = new Array(block.h).fill(0);

  for (let dy = 0; dy < block.h; dy++) {
    const y = Math.floor(block.y + dy);
    if (y < 0 || y >= height) continue;

    let nonBg = 0;
    for (let x = Math.floor(block.x); x < Math.min(Math.floor(block.x + block.w), width); x += xStep) {
      const idx = (y * width + x) * channels;
      if (idx + 2 >= data.length) continue;
      if (colorDist(bg, data[idx], data[idx + 1], data[idx + 2]) >= distThreshold) nonBg++;
    }
    proj[dy] = nonBg;
  }

  // 2) Convert projection to "content runs"
  const maxSamplesPerRow = Math.max(1, Math.floor(block.w / xStep));
  const contentThreshold = Math.max(6, Math.floor(maxSamplesPerRow * 0.03));

  const runs: Array<{ start: number; end: number }> = [];
  let runStart: number | null = null;

  for (let dy = 0; dy < block.h; dy++) {
    const hasContent = proj[dy] >= contentThreshold;
    if (hasContent) {
      if (runStart === null) runStart = dy;
    } else {
      if (runStart !== null) {
        const h = dy - runStart;
        if (h >= 10) runs.push({ start: runStart, end: dy });
        runStart = null;
      }
    }
  }
  if (runStart !== null) {
    const h = block.h - runStart;
    if (h >= 10) runs.push({ start: runStart, end: block.h });
  }

  if (runs.length < 2) return block;

  const first = runs[0];
  const firstH = first.end - first.start;

  // 3) Nickname candidate must be near top and thin
  if (first.start > 8) return block;
  if (firstH < 12 || firstH > 28) return block;

  // 4) Nickname line usually is low-saturation (grey text on bg)
  // Sample saturation in the first run region
  let saturatedPixels = 0;
  let totalPixels = 0;
  const sampleStep = 3;

  for (let y = Math.floor(block.y + first.start); y < Math.min(block.y + first.end, height); y += sampleStep) {
    for (let x = Math.floor(block.x); x < Math.min(block.x + block.w, width); x += sampleStep) {
      const idx = (y * width + x) * channels;
      if (idx + 2 >= data.length) continue;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      const { s } = rgbToHsv(r, g, b);
      if (s > 0.45) saturatedPixels++;
      totalPixels++;
    }
  }

  const satRatio = totalPixels > 0 ? saturatedPixels / totalPixels : 0;
  if (satRatio > 0.12) return block; // too colorful => likely bubble content

  // 5) Nickname line usually doesn't span wide
  const side = detectContentSide(
    data, width, height, channels, bg,
    Math.floor(block.y + first.start),
    Math.floor(block.y + first.end)
  );
  const bounds = findHorizontalBoundsSimple(
    data, width, height, channels, bg,
    Math.floor(block.y + first.start),
    Math.floor(block.y + first.end),
    side
  );

  // If the first line is very wide, it's probably not nickname
  if (bounds.w > block.w * 0.75) return block;

  // 6) Trim: remove first run + a small padding gap
  const newY = Math.floor(block.y + first.end + 2);
  const newH = Math.floor(block.h - (first.end + 2));
  if (newH < 30) return block;

  logger.debug(`[Sharp] Trimmed nickname: y ${block.y}->${newY}, h ${block.h}->${newH}`);

  return { ...block, y: newY, h: newH };
}

/**
 * Detect file icon colors in a region
 * WeChat file icons: Excel=green, PDF=red, Word=blue, PPT=orange, ZIP=yellow, TXT=gray
 * Key insight: file icons are SOLID COLOR (low variance), text has high variance
 * IMPORTANT: File icon is ALWAYS at the internal right side of the bubble (farther from avatar)
 */
function detectFileIconColorInRegion(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  bg: { r: number; g: number; b: number },
  block: MessageBlock
): FileType | null {
  const distThreshold = 80;

  // File icon is ALWAYS at the right edge of the block (farther from avatar)
  // Regardless of left/right message, icon is near block.x + block.w
  const iconX = block.x + block.w - 40;  // 40px from block's right edge
  const iconW = 35;
  const iconY = block.y + Math.floor(block.h * 0.3);
  const iconH = Math.floor(block.h * 0.4);

  logger.info(`[Sharp] File detection: block=(${block.x},${block.y},${block.w},${block.h}), iconRegion=(${iconX},${iconY},${iconW},${iconH})`);

  // ========== Gate 0: Block-level saturation check ==========
  // If the entire block has high saturation (>28%), it's likely a green text bubble, not a file
  // File cards have white/gray background (low saturation) with colored icon on right
  const blockSat = estimateSaturationRatio(data, width, height, channels, block);
  logger.info(`[Sharp] File detection Gate0: blockSat=${blockSat.toFixed(3)}`);
  if (blockSat > 0.28) {
    return null;  // Reject - high saturation across block = green text bubble
  }

  // ========== Gate 1: Compact saturated cluster check ==========
  // Verify the icon region has a compact saturated cluster (square-ish aspect ratio)
  // This filters out scattered saturated pixels that aren't a file icon
  const satBBox = findSaturatedBBox(data, width, height, channels, iconX, iconY, iconW, iconH);
  if (!satBBox) {
    logger.info(`[Sharp] File detection Gate1: FAILED - no saturated cluster`);
    return null;  // No compact saturated cluster found
  }
  logger.info(`[Sharp] File detection Gate1: satBBox w=${satBBox.w} h=${satBBox.h} ratio=${(satBBox.w / satBBox.h).toFixed(2)}`);

  // First, calculate color variance in the icon region
  // File icons have LOW variance (solid color), text has HIGH variance
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let y = iconY; y < Math.min(iconY + iconH, height); y += 2) {
    for (let x = iconX; x < Math.min(iconX + iconW, width); x += 2) {
      const idx = (y * width + x) * channels;
      sr += data[idx];
      sg += data[idx + 1];
      sb += data[idx + 2];
      n++;
    }
  }
  if (n === 0) return null;

  const mr = sr / n;
  const mg = sg / n;
  const mb = sb / n;

  let vr = 0, vg = 0, vb = 0;
  for (let y = iconY; y < Math.min(iconY + iconH, height); y += 2) {
    for (let x = iconX; x < Math.min(iconX + iconW, width); x += 2) {
      const idx = (y * width + x) * channels;
      vr += Math.pow(data[idx] - mr, 2);
      vg += Math.pow(data[idx + 1] - mg, 2);
      vb += Math.pow(data[idx + 2] - mb, 2);
    }
  }
  const variance = (vr + vg + vb) / (n * 3);

  logger.debug(`[Sharp] File detection: variance=${variance.toFixed(0)}`);

  // If variance is HIGH (>8500), it's likely text with green background, not a file icon
  // File icons with letters (like "X") inside may have variance 2000-4000
  // But green text bubbles (green background + white text) can have variance 4000-8000
  // Note: Slightly raised to 8500 to account for edge cases (e.g., 8037 was barely rejected)
  if (variance > 8500) {
    logger.debug(`[Sharp] File detection: rejected by variance > 8500`);
    return null;
  }

  // Check saturation - file icons are highly saturated (>50%)
  // Text bubble backgrounds are not saturated
  let saturatedPixels = 0;
  for (let y = iconY; y < Math.min(iconY + iconH, height); y += 2) {
    for (let x = iconX; x < Math.min(iconX + iconW, width); x += 2) {
      const idx = (y * width + x) * channels;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const { s } = rgbToHsv(r, g, b);
      if (s > 0.5) saturatedPixels++;
    }
  }

  const saturatedRatio = saturatedPixels / n;
  logger.debug(`[Sharp] File detection: iconSat=${saturatedRatio.toFixed(3)}`);

  // File icons should have >30% saturated pixels
  if (saturatedRatio < 0.3) {
    logger.debug(`[Sharp] File detection: rejected by iconSat < 0.3`);
    return null;
  }

  // Now check for saturated colors
  const colorRanges = [
    { name: 'excel' as FileType, hMin: 80, hMax: 150, sMin: 30, vMin: 40 },   // Green
    { name: 'pdf' as FileType, hMin: 0, hMax: 20, sMin: 50, vMin: 40 },      // Red
    { name: 'pdf2' as FileType, hMin: 165, hMax: 180, sMin: 50, vMin: 40 }, // Red
    { name: 'word' as FileType, hMin: 200, hMax: 260, sMin: 40, vMin: 40 }, // Blue
    { name: 'ppt' as FileType, hMin: 20, hMax: 50, sMin: 50, vMin: 50 },   // Orange
    { name: 'zip' as FileType, hMin: 35, hMax: 60, sMin: 50, vMin: 50 },   // Yellow
  ];

  let bestMatch: FileType | null = null;
  let bestRatio = 0;
  const colorCounts: Record<FileType, number> = {
    excel: 0, pdf: 0, word: 0, ppt: 0, zip: 0, txt: 0
  };
  let totalPixels = 0;

  // Sample the icon region again for color detection
  // Also collect hue histogram for debugging
  const hueBuckets = new Array(36).fill(0); // 0-360 in 10-degree buckets
  let minS = 1, maxS = 0, minV = 1, maxV = 0;
  for (let y = iconY; y < Math.min(iconY + iconH, height); y += 2) {
    for (let x = iconX; x < Math.min(iconX + iconW, width); x += 2) {
      const idx = (y * width + x) * channels;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const { h, s, v } = rgbToHsv(r, g, b);

      // Track min/max for debugging
      if (s > 0.3) {
        minS = Math.min(minS, s);
        maxS = Math.max(maxS, s);
        minV = Math.min(minV, v);
        maxV = Math.max(maxV, v);
        const bucket = Math.floor(h / 10) % 36;
        hueBuckets[bucket]++;
      }

      totalPixels++;

      // Only count colors for saturated pixels (file icons are colored)
      if (s >= 0.3 && v >= 0.4) {
        for (const color of colorRanges) {
          if (h >= color.hMin && h <= color.hMax && s >= color.sMin / 100) {
            colorCounts[color.name]++;
          }
        }
      }
    }
  }

  // Log hue distribution for debugging
  const topHues = hueBuckets.map((count, i) => ({ hue: i * 10, count }))
    .filter(b => b.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  logger.debug(`[Sharp] File detection: s range=[${minS.toFixed(2)},${maxS.toFixed(2)}], v range=[${minV.toFixed(2)},${maxV.toFixed(2)}], top hues: ${JSON.stringify(topHues)}`);

  if (totalPixels === 0) return null;

  // Log color counts for debugging
  logger.debug(`[Sharp] File detection color counts: ${JSON.stringify(colorCounts)}, total=${totalPixels}`);

  // Require at least 3% ratio with the variance filter
  for (const [name, count] of Object.entries(colorCounts)) {
    const ratio = count / totalPixels;
    if (ratio > 0.03 && ratio > bestRatio) {
      bestRatio = ratio;
      bestMatch = name as FileType;
      logger.debug(`[Sharp] File detection: ${name} ratio=${ratio.toFixed(3)} (best)`);
    }
  }

  if (!bestMatch) {
    logger.debug(`[Sharp] File detection: no color match found`);
  }

  return bestMatch;
}

/**
 * Calculate edge density using simple gradient
 */
/**
 * Calculate color variance in a block - images have high variance, text bubbles have low variance
 */
function calculateColorVariance(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  block: MessageBlock
): number {
  const blockX = Math.floor(block.x);
  const blockY = Math.floor(block.y);
  const blockW = Math.floor(block.w);
  const blockH = Math.floor(block.h);

  // Calculate mean color
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let y = blockY; y < Math.min(blockY + blockH, height); y += 2) {
    for (let x = blockX; x < Math.min(blockX + blockW, width); x += 2) {
      const idx = (y * width + x) * channels;
      if (idx + 2 >= data.length) continue;
      sr += data[idx];
      sg += data[idx + 1];
      sb += data[idx + 2];
      n++;
    }
  }
  if (n === 0) return 0;

  const mr = sr / n;
  const mg = sg / n;
  const mb = sb / n;

  // Calculate variance
  let vr = 0, vg = 0, vb = 0;
  for (let y = blockY; y < Math.min(blockY + blockH, height); y += 2) {
    for (let x = blockX; x < Math.min(blockX + blockW, width); x += 2) {
      const idx = (y * width + x) * channels;
      if (idx + 2 >= data.length) continue;
      vr += Math.pow(data[idx] - mr, 2);
      vg += Math.pow(data[idx + 1] - mg, 2);
      vb += Math.pow(data[idx + 2] - mb, 2);
    }
  }

  // Return average variance
  return (vr + vg + vb) / (n * 3);
}

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
 * WeChat images are photos - high edge density in center, NOT on edges
 */
function isImageRegion(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  block: MessageBlock,
  isDarkTheme: boolean
): boolean {
  // Detect if block has solid bubble background (text) vs varied colors (image)
  // Text bubbles: dominant color is green/white/gray
  // Images: no dominant bubble color, varied content, OR high edge density

  const blockX = Math.floor(block.x);
  const blockY = Math.floor(block.y);
  const blockW = Math.floor(block.w);
  const blockH = Math.floor(block.h);

  // Sample colors in the block
  const colorCounts = new Map<string, number>();
  let total = 0;

  for (let y = blockY; y < Math.min(blockY + blockH, height); y += 2) {
    for (let x = blockX; x < Math.min(blockX + blockW, width); x += 2) {
      const idx = (y * width + x) * channels;
      if (idx + 2 >= data.length) continue;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      // Quantize colors to reduce noise (round to nearest 16)
      const qr = Math.round(r / 16) * 16;
      const qg = Math.round(g / 16) * 16;
      const qb = Math.round(b / 16) * 16;
      const key = `${qr},${qg},${qb}`;
      colorCounts.set(key, (colorCounts.get(key) || 0) + 1);
      total++;
    }
  }

  if (total === 0) return false;

  // Find dominant color
  let maxCount = 0;
  let dominantR = 0, dominantG = 0, dominantB = 0;
  for (const [key, count] of colorCounts) {
    if (count > maxCount) {
      maxCount = count;
      const [r, g, b] = key.split(',').map(Number);
      dominantR = r; dominantG = g; dominantB = b;
    }
  }

  const dominantRatio = maxCount / total;

  // Check if dominant color is a bubble color (green/white/gray)
  // Light theme: green (G > R && G > B), white (all high), gray (all low)
  // Dark theme: also has similar colors but darker values
  const isGreen = dominantG > dominantR && dominantG > dominantB && dominantG > 150;
  const isWhite = dominantR > 200 && dominantG > 200 && dominantB > 200;
  const isGray = Math.abs(dominantR - dominantG) < 30 && Math.abs(dominantG - dominantB) < 30 && dominantR < 150;
  // Light gray in dark theme: could be white-background image
  const isLightGray = Math.abs(dominantR - dominantG) < 35 && Math.abs(dominantG - dominantB) < 35 && dominantR >= 120 && dominantR <= 220;
  // Dark theme bubble: dark gray background (R,G,B around 40-80)
  const isDarkGray = Math.abs(dominantR - dominantG) < 25 && Math.abs(dominantG - dominantB) < 25 && dominantR >= 30 && dominantR <= 100;

  const isBubbleColor = isGreen || isWhite || isGray || isDarkGray || isLightGray;

  logger.debug(`[Sharp] Block ${block.y}: dominant=${dominantR},${dominantG},${dominantB} ratio=${dominantRatio.toFixed(2)} bubble=${isBubbleColor} green=${isGreen} white=${isWhite} gray=${isGray} lightGray=${isLightGray} darkGray=${isDarkGray}`);

  // Image if: NOT a dominant bubble color
  // Also image if dominantRatio is very low (<0.35) - indicates varied content
  if (!isBubbleColor || dominantRatio < 0.35) {
    return true;
  }

  // For blocks with bubble-like dominant color and higher ratio:
  // - Green (isGreen): definitely text bubble -> text
  // - Dark gray (isDarkGray): likely text bubble, BUT if dominantRatio is low -> could be image
  // - White (isWhite): could be white-background image in dark theme -> likely image
  // - Light gray (isLightGray): could be light-background image -> likely image
  if (isGreen) {
    // Green bubbles are definitely text
    return false;
  }

  if (isDarkGray) {
    // Dark gray bubbles in dark theme: if dominantRatio is low (<0.4), likely an image
    // In light theme, dark gray is unusual - likely an image or special content
    if (dominantRatio < 0.4) {
      const edgeDensity = computeEdgeDensity(data, width, height, channels, block);
      logger.debug(`[Sharp] Block ${block.y}: darkGray with low ratio, edgeDensity=${edgeDensity.toFixed(3)}`);
      return edgeDensity > 0.12;
    }
    // In light theme, even high ratio dark gray is suspicious
    if (!isDarkTheme && dominantRatio < 0.6) {
      const edgeDensity = computeEdgeDensity(data, width, height, channels, block);
      return edgeDensity > 0.1;
    }
    return false;
  }

  if (isWhite) {
    // White background in dark theme: likely an image with white background
    // In light theme, white is a normal text bubble
    if (isDarkTheme) {
      return true;
    }
    return false; // Light theme: white = text bubble
  }

  if (isLightGray) {
    // Light gray in dark theme: could be a light-background image
    // In light theme, this could be a normal bubble
    if (isDarkTheme) {
      return true;
    }
    // Light theme: check edge density
    const edgeDensity = computeEdgeDensity(data, width, height, channels, block);
    logger.debug(`[Sharp] Block ${block.y}: lightGray lightTheme, edgeDensity=${edgeDensity.toFixed(3)}`);
    return edgeDensity > 0.12;
  }

  if (isGray) {
    // Light theme gray bubble: use edge density
    const edgeDensity = computeEdgeDensity(data, width, height, channels, block);
    logger.debug(`[Sharp] Block ${block.y}: edgeDensity=${edgeDensity.toFixed(3)}`);
    return edgeDensity > 0.12;
  }

  // For green/gray bubbles, use edge density as secondary check
  // Images have high edge density, text bubbles have low edge density
  const edgeDensity = computeEdgeDensity(data, width, height, channels, block);
  logger.debug(`[Sharp] Block ${block.y}: edgeDensity=${edgeDensity.toFixed(3)}`);

  // If edge density is high (> 0.12), it's likely an image with content
  // Text bubbles have lower edge density even with text inside
  return edgeDensity > 0.12;
}

/**
 * Compute edge density using simple Sobel-like gradient
 */
function computeEdgeDensity(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  block: MessageBlock
): number {
  const blockX = Math.floor(block.x);
  const blockY = Math.floor(block.y);
  const blockW = Math.floor(block.w);
  const blockH = Math.floor(block.h);

  let edgePixels = 0;
  let totalPixels = 0;

  // Sample every 2 pixels for performance
  for (let y = blockY + 1; y < Math.min(blockY + blockH - 1, height - 1); y += 2) {
    for (let x = blockX + 1; x < Math.min(blockX + blockW - 1, width - 1); x += 2) {
      const idx = (y * width + x) * channels;
      const idxRight = (y * width + x + 1) * channels;
      const idxDown = ((y + 1) * width + x) * channels;

      if (idx + 2 >= data.length || idxRight + 2 >= data.length || idxDown + 2 >= data.length) continue;

      // Simple gradient: horizontal and vertical
      const gx = Math.abs(data[idxRight] - data[idx]) + Math.abs(data[idxRight + 1] - data[idx + 1]) + Math.abs(data[idxRight + 2] - data[idx + 2]);
      const gy = Math.abs(data[idxDown] - data[idx]) + Math.abs(data[idxDown + 1] - data[idx + 1]) + Math.abs(data[idxDown + 2] - data[idx + 2]);

      const gradient = gx + gy;
      if (gradient > 30) { // Threshold for edge detection
        edgePixels++;
      }
      totalPixels++;
    }
  }

  return totalPixels > 0 ? edgePixels / totalPixels : 0;
}

/**
 * Detect if a region is likely a file
 */
function isFileRegion(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  bg: { r: number; g: number; b: number },
  block: MessageBlock
): boolean {
  const fileColor = detectFileIconColorInRegion(data, width, height, channels, bg, block);
  return fileColor !== null;
}

/**
 * Detect if a region is likely a video (center play button)
 * Video in WeChat has:
 * - Rectangular thumbnail (usually larger height)
 * - Play button (white triangle in center)
 * - Duration text (bottom-right corner)
 */
function isVideoRegion(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  block: MessageBlock
): boolean {
  // Videos in WeChat are typically taller (thumbnail aspect ratio)
  // Text messages are usually short - use stricter aspect ratio
  const aspectRatio = block.h / Math.max(block.w, 1);
  if (aspectRatio < 0.4 || aspectRatio > 0.65) {
    // Only accept blocks with video-like aspect ratio (typical 16:9 = 0.56)
    return false;
  }

  // Check smaller center region for play button pattern
  const centerX = Math.floor(block.x + block.w * 0.4);
  const centerY = Math.floor(block.y + block.h * 0.3);
  const centerW = Math.floor(block.w * 0.2);
  const centerH = Math.floor(block.h * 0.4);

  // Look for very bright white region in center (play button)
  // Must be almost PURE white (RGB > 245)
  let whitePixels = 0;
  let totalCenterPixels = 0;

  for (let y = centerY; y < centerY + centerH && y < height; y += 2) {
    for (let x = centerX; x < centerX + centerW && x < width; x += 2) {
      const idx = (y * width + x) * channels;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];

      // Must be almost pure white - play button is very bright
      if (r > 245 && g > 245 && b > 245) whitePixels++;
      totalCenterPixels++;
    }
  }

  const whiteRatio = totalCenterPixels > 0 ? whitePixels / totalCenterPixels : 0;

  // Check bottom-right for duration text (small dark text on light background)
  const durationX = Math.floor(block.x + block.w * 0.75);
  const durationY = Math.floor(block.y + block.h * 0.75);
  const durationW = Math.floor(block.w * 0.2);
  const durationH = Math.floor(block.h * 0.2);

  let durationEdges = 0;
  let durationTotal = 0;

  for (let y = durationY; y < durationY + durationH && y < height - 1; y += 2) {
    for (let x = durationX; x < durationX + durationW && x < width - 1; x += 2) {
      const idx = (y * width + x) * channels;
      const idxRight = idx + channels;

      const diff = Math.abs(data[idx] - data[idxRight]) + Math.abs(data[idx + 1] - data[idxRight + 1]) + Math.abs(data[idx + 2] - data[idxRight + 2]);
      if (diff > 25) durationEdges++;
      durationTotal++;
    }
  }

  const durationRatio = durationTotal > 0 ? durationEdges / durationTotal : 0;

  // Video detection requires:
  // 1. Aspect ratio 0.4-0.65 (video-like)
  // 2. Center has very bright white pixels (play button) - require 5%
  // 3. Bottom-right has text edges (duration) - require 30%
  const hasPlayButton = whiteRatio > 0.05;  // At least 5% very bright white
  const hasDuration = durationRatio > 0.30;  // At least 30% edge density

  return hasPlayButton && hasDuration;
}

/**
 * Full pipeline: segment and classify message blocks
 * @param imagePath - Path to the screenshot
 * @param options.skipTop - Skip blocks in the top area (header/sidebar), default 100 pixels
 */
export async function processScreenshot(
  imagePath: string,
  options?: { skipTop?: number }
): Promise<SegmentResult> {
  // Default to 0 - assume screenshot is already cropped to chat area
  // Use options.skipTop to override if needed (e.g., 100-150 for full WeChat window)
  const skipTop = options?.skipTop ?? 0;

  logger.info(`[Sharp] Processing screenshot: ${imagePath}`);

  // First segment into blocks
  let blocks = await segmentMessageStrips(imagePath);

  // Filter out blocks in the header/sidebar area
  blocks = blocks.filter(b => b.y >= skipTop);

  // Then classify each block
  const { data, width, height, channels } = await getImageData(imagePath);

  // Estimate background for file detection
  const bg = estimateBackgroundRgb(data, width, height, channels, skipTop);

  // Determine theme for image detection (light vs dark theme use different heuristics)
  const bgBrightness = (bg.r + bg.g + bg.b) / 3;
  const isDarkTheme = bgBrightness < 80;

  // Trim group nickname line (only when it looks like a left-side message)
  blocks = blocks.map(b => {
    // quick heuristic: left blocks tend to have smaller x
    if (b.x < width * 0.45) {
      return trimGroupNicknameLine(data, width, height, channels, bg, b);
    }
    return b;
  });

  for (const block of blocks) {
    // Detection order:
    // 1. First check if it's a file (text bubble + colored icon on right) - check BEFORE image
    //    because file has icon that could be misdetected as image content
    // 2. Then check if it's an image (varied colors)
    // 3. Otherwise it's text

    // For file detection: expand short blocks to capture full file card
    // In dark theme, gray bubble may not be detected as content, truncating the block
    let blockForFile = block;
    if (block.h < 70) {
      // Expand block downward to find file icon - use expected file card height (~80px)
      const expandedH = Math.min(90, block.h + 50);
      blockForFile = { ...block, h: expandedH };
      logger.debug(`[Sharp] Expanded short block for file detection: h=${block.h}->${expandedH}`);
    }

    // First check for file (must be before image check)
    if (isFileRegion(data, width, height, channels, bg, blockForFile)) {
      block.type = 'file';
      // If we expanded for detection, keep the expanded height for cropping
      if (block.h < 70 && blockForFile.h > block.h) {
        block.h = blockForFile.h;
      }
    } else if (isImageRegion(data, width, height, channels, block, isDarkTheme)) {
      // If image, check if it has a play button (video)
      if (isVideoRegion(data, width, height, channels, block)) {
        block.type = 'video';
      } else {
        block.type = 'image';
      }
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
