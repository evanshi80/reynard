/**
 * Image Stitcher Module
 * Deduplicates and stitches patrol screenshots for VLM analysis
 */
import sharp from 'sharp';
import logger from '../utils/logger';

/**
 * Quick check if two images are nearly identical.
 * Resizes both to 100x100 grayscale and compares pixels.
 * @returns true if similarity > 98%
 */
export async function isDuplicateImage(a: Buffer, b: Buffer): Promise<boolean> {
  const size = 100;
  const [thumbA, thumbB] = await Promise.all([
    sharp(a).resize(size, size, { fit: 'fill' }).grayscale().raw().toBuffer(),
    sharp(b).resize(size, size, { fit: 'fill' }).grayscale().raw().toBuffer(),
  ]);

  if (thumbA.length !== thumbB.length) return false;

  let matchCount = 0;
  for (let i = 0; i < thumbA.length; i++) {
    if (Math.abs(thumbA[i] - thumbB[i]) < 10) {
      matchCount++;
    }
  }

  const similarity = matchCount / thumbA.length;
  return similarity > 0.98;
}

/**
 * Detect vertical overlap between two screenshots.
 * Compares bottom of `older` with top of `newer` using downscaled grayscale strips.
 * @returns number of overlap pixels (0 if no overlap found)
 */
export async function detectOverlap(older: Buffer, newer: Buffer): Promise<number> {
  const [olderMeta, newerMeta] = await Promise.all([
    sharp(older).metadata(),
    sharp(newer).metadata(),
  ]);

  const olderH = olderMeta.height!;
  const newerH = newerMeta.height!;
  const width = olderMeta.width!;

  // Downscale width for faster comparison
  const thumbWidth = Math.max(Math.round(width / 4), 50);
  const stripHeight = 20;
  const maxSearch = Math.min(Math.round(Math.min(olderH, newerH) * 0.8), 600);

  if (maxSearch < stripHeight) return 0;

  // Get bottom portion of older image and top portion of newer image
  const [olderBottom, newerTop] = await Promise.all([
    sharp(older)
      .extract({ left: 0, top: olderH - maxSearch, width, height: maxSearch })
      .resize(thumbWidth, maxSearch, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer(),
    sharp(newer)
      .extract({ left: 0, top: 0, width, height: maxSearch })
      .resize(thumbWidth, maxSearch, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer(),
  ]);

  // Try overlap values from large to small (prefer larger overlaps)
  for (let overlap = maxSearch - stripHeight; overlap >= stripHeight; overlap -= stripHeight) {
    // Compare: older bottom strip vs newer top strip at this overlap
    const olderStart = (maxSearch - overlap) * thumbWidth;
    const compareLen = overlap * thumbWidth;

    if (olderStart + compareLen > olderBottom.length || compareLen > newerTop.length) continue;

    let matchCount = 0;
    for (let i = 0; i < compareLen; i++) {
      if (Math.abs(olderBottom[olderStart + i] - newerTop[i]) < 15) {
        matchCount++;
      }
    }

    const similarity = matchCount / compareLen;
    if (similarity > 0.85) {
      logger.debug(`Overlap detected: ${overlap}px (similarity: ${(similarity * 100).toFixed(1)}%)`);
      return overlap;
    }
  }

  return 0;
}

/**
 * Stitch two images vertically, removing detected overlap.
 */
async function stitchTwo(older: Buffer, newer: Buffer): Promise<Buffer> {
  const overlap = await detectOverlap(older, newer);

  const [olderMeta, newerMeta] = await Promise.all([
    sharp(older).metadata(),
    sharp(newer).metadata(),
  ]);

  const olderH = olderMeta.height!;
  const newerH = newerMeta.height!;
  const width = Math.max(olderMeta.width!, newerMeta.width!);
  const totalHeight = olderH + newerH - overlap;

  // Crop the overlapping top portion from the newer image
  const newerCropped = overlap > 0
    ? await sharp(newer)
        .extract({ left: 0, top: overlap, width: newerMeta.width!, height: newerH - overlap })
        .toBuffer()
    : newer;

  const newerCroppedH = newerH - overlap;

  return sharp({
    create: {
      width,
      height: totalHeight,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([
      { input: older, top: 0, left: 0 },
      { input: newerCropped, top: olderH, left: 0 },
    ])
    .png()
    .toBuffer();
}

/**
 * Stitch multiple images together (oldest first).
 * Deduplicates adjacent identical images, then stitches pairwise.
 */
export async function stitchImages(images: Buffer[]): Promise<Buffer> {
  if (images.length === 0) {
    throw new Error('No images to stitch');
  }
  if (images.length === 1) {
    return images[0];
  }

  // Filter out adjacent duplicates
  const unique: Buffer[] = [images[0]];
  for (let i = 1; i < images.length; i++) {
    const dup = await isDuplicateImage(images[i - 1], images[i]);
    if (!dup) {
      unique.push(images[i]);
    } else {
      logger.debug(`Skipping duplicate image at index ${i}`);
    }
  }

  if (unique.length === 1) {
    return unique[0];
  }

  // Stitch pairwise left to right (oldest on top)
  let result = unique[0];
  for (let i = 1; i < unique.length; i++) {
    result = await stitchTwo(result, unique[i]);
  }

  return result;
}

/**
 * Compare a new screenshot against a baseline and extract only the new (non-overlapping) portion.
 * Returns null if the images are duplicates (no new content).
 */
export async function extractNewContent(baseline: Buffer, newer: Buffer): Promise<Buffer | null> {
  // If they're nearly identical, no new content
  if (await isDuplicateImage(baseline, newer)) {
    return null;
  }

  const overlap = await detectOverlap(baseline, newer);
  const newerMeta = await sharp(newer).metadata();
  const newerH = newerMeta.height!;
  const newerW = newerMeta.width!;

  if (overlap <= 0) {
    // No overlap found — entirely new content (or chat changed completely)
    return newer;
  }

  const newHeight = newerH - overlap;
  if (newHeight <= 20) {
    // Only a sliver of new content, likely noise
    return null;
  }

  logger.debug(`Extracting new content: ${newHeight}px below ${overlap}px overlap`);
  return sharp(newer)
    .extract({ left: 0, top: overlap, width: newerW, height: newHeight })
    .png()
    .toBuffer();
}

/**
 * Resize image if it exceeds maxHeight, maintaining aspect ratio.
 */
export async function enforceMaxHeight(image: Buffer, maxHeight: number): Promise<Buffer> {
  const meta = await sharp(image).metadata();
  if (!meta.height || meta.height <= maxHeight) {
    return image;
  }

  logger.debug(`Image height ${meta.height}px exceeds max ${maxHeight}px, resizing...`);
  return sharp(image)
    .resize({ height: maxHeight, fit: 'inside' })
    .png()
    .toBuffer();
}
