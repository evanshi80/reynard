import { config } from '../config';
import logger from '../utils/logger';
import fs from 'fs';
import sharp from 'sharp';
import { WindowFinder } from './windowFinder';

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Screenshot capturer with auto-detected chat area
 */
export class ScreenshotCapturer {
  private saveDir: string;
  private windowFinder: WindowFinder;

  // Inertia for chat area boundary detection (temporal stability)
  private lastDividerX: number | null = null;
  private lastDividerTs: number = 0;

  // Inertia for horizontal separators (temporal stability)
  private lastHeaderBottomY: number | null = null;
  private lastInputTopY: number | null = null;

  constructor() {
    this.saveDir = config.capture.screenshotDir;
    this.windowFinder = new WindowFinder();

    const shouldSave = config.capture.saveScreenshots;
    if (shouldSave && !fs.existsSync(this.saveDir)) {
      fs.mkdirSync(this.saveDir, { recursive: true });
    }
  }

  /**
   * Get window bounds using native Windows API (via WindowFinder)
   */
  private getWindowBounds(): WindowBounds | null {
    try {
      const windowBounds = this.windowFinder.findWeChatWindow();
      if (!windowBounds) {
        return null;
      }

      const dpiScale = this.windowFinder.getDpiScaleForLastWindow();

      logger.debug(`Applying DPI scale ${dpiScale} to coordinates`);

      return {
        x: Math.round(windowBounds.x * dpiScale),
        y: Math.round(windowBounds.y * dpiScale),
        width: Math.round(windowBounds.width * dpiScale),
        height: Math.round(windowBounds.height * dpiScale),
      };
    } catch (error) {
      logger.error('getWindowBounds error:', error);
      return null;
    }
  }

  /**
   * Detect chat area boundary using column-wise edge energy with band-based selection
   * WeChat has two panels: left (chat list) and right (chat content)
   * The divider shows as a continuous vertical band in edge energy
   */
  private detectChatAreaBoundary(imageBuffer: Buffer, width: number, height: number): number {
    // Parameters
    const baseStart = Math.floor(width * 0.10); // Start from 10%
    // Exclude right scrollbar area: use width - max(30px, 3% width)
    const scrollbarPad = Math.max(30, Math.floor(width * 0.03));
    const baseEnd = width - scrollbarPad; // Exclude scrollbar area
    const skipTop = Math.floor(height * 0.10);    // Skip header (10%)
    const skipBottom = Math.floor(height * 0.15);  // Skip input area (15%)
    const smoothWindow = 3;                      // Smoothing window size

    // === INERTIA: Prefer local search near last divider to reduce jitter ===
    let searchStart = baseStart;
    let searchEnd = baseEnd;
    if (this.lastDividerX != null) {
      const localRadius = Math.floor(width * 0.08); // ~8% width
      searchStart = Math.max(baseStart, this.lastDividerX - localRadius);
      searchEnd = Math.min(baseEnd, this.lastDividerX + localRadius);
      logger.debug(`detectChatAreaBoundary: local search ${searchStart}-${searchEnd} (lastX=${this.lastDividerX})`);
    }

    // Collect diff samples for adaptive threshold
    const diffSamples: number[] = [];
    const stepY = Math.max(1, Math.floor((height - skipTop - skipBottom) / 50));

    // First pass: collect diff samples to compute adaptive threshold
    for (let x = searchStart + 1; x < searchEnd; x++) {
      for (let y = skipTop; y < height - skipBottom; y += stepY) {
        const idx = (y * width + x) * 3;
        const prevIdx = (y * width + (x - 1)) * 3;
        const curr = (imageBuffer[idx] + imageBuffer[idx + 1] + imageBuffer[idx + 2]) / 3;
        const prev = (imageBuffer[prevIdx] + imageBuffer[prevIdx + 1] + imageBuffer[prevIdx + 2]) / 3;
        diffSamples.push(Math.abs(curr - prev));
      }
    }

    // Adaptive threshold: P75 of all diffs, clamped to [8, 30]
    diffSamples.sort((a, b) => a - b);
    const p75 = diffSamples[Math.floor(diffSamples.length * 0.75)] || 15;
    const diffThreshold = Math.max(8, Math.min(30, p75));

    // Calculate edge metrics for each column
    const edgeData: { x: number; energy: number; coverage: number; continuity: number; score: number }[] = [];

    for (let x = searchStart + 1; x < searchEnd; x++) {
      let energy = 0;
      let coverageCount = 0;
      let longestRun = 0;
      let currentRun = 0;
      let count = 0;

      // Track runs of pixels above threshold
      let prevAbove = false;

      for (let y = skipTop; y < height - skipBottom; y += stepY) {
        const idx = (y * width + x) * 3;
        const prevIdx = (y * width + (x - 1)) * 3;
        const curr = (imageBuffer[idx] + imageBuffer[idx + 1] + imageBuffer[idx + 2]) / 3;
        const prev = (imageBuffer[prevIdx] + imageBuffer[prevIdx + 1] + imageBuffer[prevIdx + 2]) / 3;

        const diff = Math.abs(curr - prev);
        energy += diff;
        count++;

        if (diff > diffThreshold) {
          coverageCount++;
          if (prevAbove) {
            currentRun++;
          } else {
            currentRun = 1;
            prevAbove = true;
          }
          longestRun = Math.max(longestRun, currentRun);
        } else {
          prevAbove = false;
        }
      }

      if (count > 0) {
        const e = energy / count;
        const c = coverageCount / count; // Coverage: ratio above threshold
        const r = longestRun / count;    // Continuity: longest run / total
        edgeData.push({
          x,
          energy: e,
          coverage: c,
          continuity: r,
          score: e * c * (0.5 + 0.5 * r), // Weight both energy and continuity
        });
      }
    }

    if (edgeData.length === 0) {
      const fallbackX = Math.floor(width * 0.32);
      logger.debug(`detectChatAreaBoundary: no edge data, fallback x=${fallbackX}`);
      return fallbackX;
    }

    // Smooth the scores
    const smoothed: { x: number; score: number }[] = [];
    for (let i = 0; i < edgeData.length; i++) {
      let sum = 0, w = 0;
      for (let j = -smoothWindow; j <= smoothWindow; j++) {
        if (i + j >= 0 && i + j < edgeData.length) {
          const weight = 1 - Math.abs(j) / (smoothWindow + 1);
          sum += edgeData[i + j].score * weight;
          w += weight;
        }
      }
      smoothed.push({ x: edgeData[i].x, score: w > 0 ? sum / w : 0 });
    }

    // Find bands: groups of consecutive x with score above threshold
    const meanScore = smoothed.reduce((a, b) => a + b.score, 0) / smoothed.length;
    const bandThreshold = meanScore * 1.3; // 30% above mean

    interface Band { startX: number; endX: number; centerX: number; maxScore: number; }
    const bands: Band[] = [];
    let currentBand: Band | null = null;

    for (let i = 0; i < smoothed.length; i++) {
      const point = smoothed[i];
      if (point.score >= bandThreshold) {
        if (!currentBand) {
          currentBand = { startX: point.x, endX: point.x, centerX: point.x, maxScore: point.score };
        } else {
          // Check if consecutive (gap <= 2 to handle minor dips)
          if (point.x - currentBand.endX <= 2) {
            currentBand.endX = point.x;
            currentBand.centerX = Math.floor((currentBand.startX + currentBand.endX) / 2);
            currentBand.maxScore = Math.max(currentBand.maxScore, point.score);
          } else {
            bands.push(currentBand);
            currentBand = { startX: point.x, endX: point.x, centerX: point.x, maxScore: point.score };
          }
        }
      } else {
        if (currentBand) {
          bands.push(currentBand);
          currentBand = null;
        }
      }
    }
    if (currentBand) bands.push(currentBand);

    // Filter bands: must be at least 2px wide (divider is a band, not a single pixel)
    const validBands = bands.filter(b => b.endX - b.startX >= 2);

    // Hard guard: divider must be in reasonable range
    const minX = Math.floor(width * 0.12);
    const maxX = Math.floor(width * 0.75);
    const guardedBands = validBands.filter(b => b.centerX >= minX && b.centerX <= maxX);

    if (guardedBands.length > 0) {
      const usableHeight = (height - skipTop - skipBottom);

      // Score each band with:
      // - textureDelta (left should be more textured)
      // - vertical continuity (divider should be a tall continuous line)
      // - coverage (divider should be present across many y positions)
      const scored = guardedBands.map(b => {
        const centerX = b.centerX;

        const delta = this.computeLeftRightTextureDelta(imageBuffer, width, height, centerX, skipTop, skipBottom);

        // Measure vertical continuity at the exact candidate X
        const strength = this.measureVerticalDividerStrength(
          imageBuffer,
          width,
          height,
          centerX,
          skipTop,
          skipBottom,
          diffThreshold,
        );

        // Normalize continuity by usable height
        const continuityRatio = usableHeight > 0 ? (strength.maxRunPx / usableHeight) : 0;

        // Final score: prioritize vertical continuity, then texture delta, then band maxScore
        // (Weights are empirical; continuity is the most discriminative for a true divider.)
        const score =
          (continuityRatio * 100) +         // main driver
          (strength.coverage * 20) +        // secondary
          (Math.max(0, delta) * 1.0) +      // only reward positive delta
          (b.maxScore * 0.05);              // weak tie-break

        return {
          band: b,
          centerX,
          delta,
          maxRunPx: strength.maxRunPx,
          coverage: strength.coverage,
          continuityRatio,
          score,
        };
      });

      // Prefer highest score
      scored.sort((a, b) => b.score - a.score);
      const best = scored[0];

      // Hard gates to avoid pathological divider choices:
      // 1) Left must be more textured (delta >= 0)
      // 2) Divider must be tall enough (continuityRatio >= 0.55 typically works well)
      // 3) Coverage must be non-trivial
      const minContinuity = 0.55;
      const minCoverage = 0.10;

      const highConfidence =
        best.delta >= 0 &&
        best.continuityRatio >= minContinuity &&
        best.coverage >= minCoverage;

      if (!highConfidence) {
        logger.debug(
          `detectChatAreaBoundary: low confidence candidate x=${best.centerX} ` +
          `delta=${best.delta.toFixed(1)} run=${best.maxRunPx}px ` +
          `cont=${(best.continuityRatio * 100).toFixed(0)}% cov=${(best.coverage * 100).toFixed(0)}% ` +
          `=> using lastDivider/fallback without updating`,
        );

        // Do not update EMA memory when confidence is low
        const x = this.applyInertiaEma(best.centerX, false);

        // If we don't have a meaningful lastDividerX yet, fallback
        if (x == null || x <= 0) {
          return this.handleDividerFallback(width);
        }
        return x;
      }

      // High confidence: update EMA
      const finalX = this.applyInertiaEma(best.centerX, true);

      logger.debug(
        `detectChatAreaBoundary: selected x=${best.centerX} (final=${finalX}) ` +
        `delta=${best.delta.toFixed(1)} run=${best.maxRunPx}px ` +
        `cont=${(best.continuityRatio * 100).toFixed(0)}% cov=${(best.coverage * 100).toFixed(0)}% score=${best.score.toFixed(1)}`,
      );

      return finalX;
    }

    // Ultimate fallback
    return this.handleDividerFallback(width);
  }

  /**
   * Apply EMA smoothing to detected divider X.
   * Only update lastDividerX when allowUpdate=true to avoid locking onto a wrong divider.
   */
  private applyInertiaEma(detectedX: number, allowUpdate: boolean): number {
    if (this.lastDividerX == null) {
      // First-time initialization: only accept when allowUpdate=true,
      // otherwise initialize with detectedX but mark as weak (still better than random).
      this.lastDividerX = detectedX;
      this.lastDividerTs = Date.now();
      return detectedX;
    }

    if (!allowUpdate) {
      // Do NOT update memory. Return last known divider to keep stable cropping.
      return this.lastDividerX;
    }

    const alpha = 0.35; // 35% new, 65% old
    const x = Math.round(this.lastDividerX * (1 - alpha) + detectedX * alpha);
    this.lastDividerX = x;
    this.lastDividerTs = Date.now();
    return x;
  }

  /**
   * Handle fallback when no valid divider found
   */
  private handleDividerFallback(width: number): number {
    const fallbackX = Math.floor(width * 0.32);
    if (this.lastDividerX != null) {
      // Use last known good value with slight decay
      const decay = 0.9;
      const x = Math.round(this.lastDividerX * decay + fallbackX * (1 - decay));
      this.lastDividerX = x;
      this.lastDividerTs = Date.now();
      logger.debug(`detectChatAreaBoundary: using decayed fallback x=${x}`);
      return x;
    }
    logger.debug(`detectChatAreaBoundary: no prior, using fallback x=${fallbackX}`);
    this.lastDividerX = fallbackX;
    this.lastDividerTs = Date.now();
    return fallbackX;
  }

  /**
   * Evaluate whether a candidate X is a true panel divider by measuring:
   * 1) vertical continuity (max run length where diff > threshold)
   * 2) coverage ratio (how many y samples exceed threshold)
   *
   * IMPORTANT: we scan with a small stepY for speed, but we still require
   * a long continuous run (in pixels) to avoid picking internal edges.
   */
  private measureVerticalDividerStrength(
    imageBuffer: Buffer,
    width: number,
    height: number,
    x: number,
    skipTop: number,
    skipBottom: number,
    diffThreshold: number,
  ): { maxRunPx: number; coverage: number } {
    // Safety clamp
    const xx = Math.max(1, Math.min(width - 2, x));

    // Use denser sampling than your previous ~50 samples.
    // 2px step is a good compromise: stable but not too slow.
    const stepY = 2;

    const yStart = skipTop;
    const yEnd = height - skipBottom;

    let aboveCount = 0;
    let total = 0;

    let currentRunSamples = 0;
    let maxRunSamples = 0;

    for (let y = yStart; y < yEnd; y += stepY) {
      const idx = (y * width + xx) * 3;
      const prevIdx = (y * width + (xx - 1)) * 3;

      const curr = (imageBuffer[idx] + imageBuffer[idx + 1] + imageBuffer[idx + 2]) / 3;
      const prev = (imageBuffer[prevIdx] + imageBuffer[prevIdx + 1] + imageBuffer[prevIdx + 2]) / 3;

      const diff = Math.abs(curr - prev);

      total++;
      if (diff > diffThreshold) {
        aboveCount++;
        currentRunSamples++;
        if (currentRunSamples > maxRunSamples) maxRunSamples = currentRunSamples;
      } else {
        currentRunSamples = 0;
      }
    }

    const coverage = total > 0 ? aboveCount / total : 0;
    const maxRunPx = maxRunSamples * stepY;

    return { maxRunPx, coverage };
  }

  /**
   * Compute texture delta: left side vs right side of candidate divider
   * True divider: left panel (chat list) is more textured than right panel (chat area)
   */
  private computeLeftRightTextureDelta(
    imageBuffer: Buffer,
    width: number,
    height: number,
    x: number,
    skipTop: number,
    skipBottom: number,
  ): number {
    const bandHalf = 18;   // ~36px band width
    const gap = 6;         // gap around divider
    const leftStart = Math.max(1, x - gap - bandHalf);
    const leftEnd = Math.max(1, x - gap);
    const rightStart = Math.min(width - 2, x + gap);
    const rightEnd = Math.min(width - 2, x + gap + bandHalf);

    const stepY = Math.max(1, Math.floor((height - skipTop - skipBottom) / 60));

    const avgEnergy = (xs: number, xe: number) => {
      let sum = 0;
      let n = 0;
      for (let xx = xs; xx < xe; xx++) {
        for (let y = skipTop; y < height - skipBottom; y += stepY) {
          const idx = (y * width + xx) * 3;
          const prevIdx = (y * width + (xx - 1)) * 3;
          const curr = (imageBuffer[idx] + imageBuffer[idx + 1] + imageBuffer[idx + 2]) / 3;
          const prev = (imageBuffer[prevIdx] + imageBuffer[prevIdx + 1] + imageBuffer[prevIdx + 2]) / 3;
          sum += Math.abs(curr - prev);
          n++;
        }
      }
      return n > 0 ? sum / n : 0;
    };

    const left = avgEnergy(leftStart, leftEnd);
    const right = avgEnergy(rightStart, rightEnd);
    return left - right; // positive => left more textured => likely true divider
  }

  /**
   * Detect the chat content area within the right panel
   * Includes the chat group name header at the top
   */
  /**
   * Detect horizontal separators (header bottom & input top) inside the right chat panel.
   * Pure edge-based: row-wise energy + coverage (run across most ROI width).
   */
  private detectChatHorizontalSeparators(
    imageBuffer: Buffer,
    width: number,
    height: number,
    roi: { x: number; y: number; width: number; height: number },
  ): { headerBottomY: number; inputTopY: number; confidence: number } {
    const { x, y, width: w, height: h } = roi;

    // Safety guards
    if (w < 200 || h < 300) {
      const fallbackHeader = Math.floor(height * 0.12);
      const fallbackInput = Math.floor(height * 0.88);
      return { headerBottomY: fallbackHeader, inputTopY: fallbackInput, confidence: 0 };
    }

    const yStart = y;
    const yEnd = y + h;

    // Compute row-wise energy: average |I(x,y) - I(x,y-1)| over ROI width.
    // Use stride for speed.
    const stepX = 2;
    const stepY = 1;

    const energy: number[] = [];
    for (let yy = yStart + 1; yy < yEnd; yy += stepY) {
      let sum = 0;
      let count = 0;

      for (let xx = x; xx < x + w; xx += stepX) {
        const idx = (yy * width + xx) * 3;
        const prevIdx = ((yy - 1) * width + xx) * 3;

        const curr = (imageBuffer[idx] + imageBuffer[idx + 1] + imageBuffer[idx + 2]) / 3;
        const prev = (imageBuffer[prevIdx] + imageBuffer[prevIdx + 1] + imageBuffer[prevIdx + 2]) / 3;

        sum += Math.abs(curr - prev);
        count++;
      }

      energy.push(count > 0 ? sum / count : 0);
    }

    // Smooth energy (simple triangular window)
    const smoothWindow = 6;
    const smoothed: number[] = [];
    for (let i = 0; i < energy.length; i++) {
      let s = 0;
      let ww = 0;
      for (let j = -smoothWindow; j <= smoothWindow; j++) {
        const k = i + j;
        if (k >= 0 && k < energy.length) {
          const weight = 1 - Math.abs(j) / (smoothWindow + 1);
          s += energy[k] * weight;
          ww += weight;
        }
      }
      smoothed.push(ww > 0 ? s / ww : 0);
    }

    // Adaptive threshold based on P75
    const sorted = [...smoothed].sort((a, b) => a - b);
    const p75 = sorted[Math.floor(sorted.length * 0.75)] || 10;
    const diffThreshold = Math.max(6, Math.min(25, p75));

    // Helper: compute coverage of a row edge (how much of ROI width exceeds threshold)
    const rowCoverage = (yy: number) => {
      let above = 0;
      let total = 0;
      for (let xx = x; xx < x + w; xx += stepX) {
        const idx = (yy * width + xx) * 3;
        const prevIdx = ((yy - 1) * width + xx) * 3;
        const curr = (imageBuffer[idx] + imageBuffer[idx + 1] + imageBuffer[idx + 2]) / 3;
        const prev = (imageBuffer[prevIdx] + imageBuffer[prevIdx + 1] + imageBuffer[prevIdx + 2]) / 3;
        const d = Math.abs(curr - prev);
        if (d > diffThreshold) above++;
        total++;
      }
      return total > 0 ? above / total : 0;
    };

    // Search bands (top & bottom)
    const topMin = Math.floor(h * 0.05);
    const topMax = Math.floor(h * 0.30);
    const botMin = Math.floor(h * 0.65);
    const botMax = Math.floor(h * 0.95);

    const findBestBandCenter = (from: number, to: number) => {
      const mean = smoothed.reduce((a, b) => a + b, 0) / smoothed.length;
      const bandTh = mean * 1.25;

      let bestCenter = -1;
      let bestScore = -1;

      let inBand = false;
      let bandMax = 0;
      let bandMaxIdx = 0;

      for (let i = from; i < to; i++) {
        const v = smoothed[i];
        if (v >= bandTh) {
          if (!inBand) {
            inBand = true;
            bandMax = v;
            bandMaxIdx = i;
          } else {
            if (v > bandMax) {
              bandMax = v;
              bandMaxIdx = i;
            }
          }
        } else {
          if (inBand) {
            const bandEnd = i - 1;
            const center = bandMaxIdx;
            const yy = yStart + 1 + center; // map to absolute y
            const cov = rowCoverage(yy);

            // Score favors strong band + high coverage
            const score = bandMax + cov * 20;

            if (cov >= 0.55 && score > bestScore) {
              bestScore = score;
              bestCenter = yy;
            }

            inBand = false;
          }
        }
      }

      // close open band
      if (inBand) {
        const center = bandMaxIdx;
        const yy = yStart + 1 + center;
        const cov = rowCoverage(yy);
        const score = bandMax + cov * 20;
        if (cov >= 0.55 && score > bestScore) {
          bestScore = score;
          bestCenter = yy;
        }
      }

      return { y: bestCenter, score: bestScore };
    };

    const top = findBestBandCenter(topMin, topMax);
    const bot = findBestBandCenter(botMin, botMax);

    // Fallbacks if one is not found
    let headerBottomY = top.y > 0 ? top.y : Math.floor(height * 0.12);
    let inputTopY = bot.y > 0 ? bot.y : Math.floor(height * 0.88);

    // Sanity: ensure ordering
    const minGap = 200;
    if (inputTopY - headerBottomY < minGap) {
      headerBottomY = Math.floor(height * 0.12);
      inputTopY = Math.floor(height * 0.88);
    }

    // Confidence: combine band scores presence
    const conf = (top.score > 0 ? 0.5 : 0) + (bot.score > 0 ? 0.5 : 0);

    return { headerBottomY, inputTopY, confidence: conf };
  }

  /**
   * Detect chat message list area (exclude header & input) within the right panel.
   */
  private detectChatContentArea(
    imageBuffer: Buffer,
    width: number,
    height: number,
    chatStartX: number,
  ): { x: number; y: number; width: number; height: number } {
    // Right panel ROI
    const paddingLeft = 10;
    const paddingRight = 12;

    const roi = {
      x: Math.max(0, chatStartX + paddingLeft),
      y: 0,
      width: Math.max(1, width - (chatStartX + paddingLeft) - paddingRight),
      height: height,
    };

    // Detect horizontal separators
    const sep = this.detectChatHorizontalSeparators(imageBuffer, width, height, roi);

    // Apply inertia (EMA) only if confidence is decent
    const allowUpdate = sep.confidence >= 0.5;

    const ema = (prev: number | null, next: number) => {
      if (prev == null) return next;
      if (!allowUpdate) return prev;
      const alpha = 0.35;
      return Math.round(prev * (1 - alpha) + next * alpha);
    };

    const headerBottomY = ema(this.lastHeaderBottomY, sep.headerBottomY);
    const inputTopY = ema(this.lastInputTopY, sep.inputTopY);

    this.lastHeaderBottomY = headerBottomY;
    this.lastInputTopY = inputTopY;

    // Message area is between headerBottomY and inputTopY
    const y0 = Math.max(0, headerBottomY + 2);
    const y1 = Math.min(height, inputTopY - 2);

    // Fallback if weird
    const minHeight = 200;
    if (y1 - y0 < minHeight) {
      const fallbackTop = 0;
      const fallbackBottom = height - Math.floor(height * 0.12);
      return {
        x: roi.x,
        y: fallbackTop,
        width: roi.width,
        height: Math.max(1, fallbackBottom - fallbackTop),
      };
    }

    return {
      x: roi.x,
      y: y0,
      width: roi.width,
      height: y1 - y0,
    };
  }

  /**
   * Clamp bbox to image bounds and ensure minimum size
   */
  private clampBbox(imgWidth: number, imgHeight: number, bbox: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number } {
    let x = Math.max(0, Math.min(bbox.x, imgWidth - 1));
    let y = Math.max(0, Math.min(bbox.y, imgHeight - 1));
    let w = Math.max(1, Math.min(bbox.width, imgWidth - x));
    let h = Math.max(1, Math.min(bbox.height, imgHeight - y));
    return { x, y, width: w, height: h };
  }

  /**
   * Extract region from image buffer
   */
  private extractRegion(imageBuffer: Buffer, width: number, height: number, bbox: { x: number; y: number; width: number; height: number }): Buffer {
    const { x, y, width: w, height: h } = bbox;

    const regionBuffer = Buffer.alloc(w * h * 3);

    for (let row = 0; row < h; row++) {
      const srcIdx = ((y + row) * width + x) * 3;
      const dstIdx = row * w * 3;
      const srcSlice = imageBuffer.subarray(srcIdx, srcIdx + w * 3);
      srcSlice.copy(regionBuffer, dstIdx);
    }

    return regionBuffer;
  }

  getScreenshotDir(): string {
    return this.saveDir;
  }

  /**
   * Get the window handle for window control operations
   */
  getWindowHandle(): any {
    return this.windowFinder.getLastWindowHandle();
  }

  /**
   * Get the window finder for direct operations
   */
  getWindowFinder(): WindowFinder {
    return this.windowFinder;
  }

  /**
   * Capture the full chat area as a PNG buffer.
   * Uses pixel-level separator detection to accurately exclude the sidebar.
   */
  async captureFullChatArea(): Promise<Buffer | null> {
    try {
      const robot = require('robotjs');

      const bounds = this.getWindowBounds();
      if (!bounds || bounds.width <= 100 || bounds.height <= 100) {
        logger.warn('captureFullChatArea: invalid window bounds');
        return null;
      }

      const bitmap = robot.screen.capture(bounds.x, bounds.y, bounds.width, bounds.height);
      const rawPixels = bitmap.image;

      // Convert BGRA → RGB (3 channels)
      // RobotJS returns BGRA on Windows
      const rgbBuffer = Buffer.alloc(bounds.width * bounds.height * 3);
      for (let i = 0; i < bounds.width * bounds.height; i++) {
        const b = rawPixels[i * 4];     // B
        const g = rawPixels[i * 4 + 1]; // G
        const r = rawPixels[i * 4 + 2]; // R
        rgbBuffer[i * 3] = r;
        rgbBuffer[i * 3 + 1] = g;
        rgbBuffer[i * 3 + 2] = b;
      }

      // Detect chat area boundary via pixel analysis
      const chatStartX = this.detectChatAreaBoundary(rgbBuffer, bounds.width, bounds.height);
      const chatAreaRaw = this.detectChatContentArea(rgbBuffer, bounds.width, bounds.height, chatStartX);
      const chatArea = this.clampBbox(bounds.width, bounds.height, chatAreaRaw);

      // Guard against too small areas: use lastDividerX as fallback
      if (chatArea.width < 200 || chatArea.height < 200) {
        logger.warn(`captureFullChatArea: chat area too small after clamp: ${JSON.stringify(chatArea)}`);

        // Fallback: use last known divider if present (do not update it here)
        if (this.lastDividerX != null) {
          const fallbackAreaRaw = this.detectChatContentArea(rgbBuffer, bounds.width, bounds.height, this.lastDividerX);
          const fallbackArea = this.clampBbox(bounds.width, bounds.height, fallbackAreaRaw);

          logger.warn(`captureFullChatArea: retry with lastDividerX=${this.lastDividerX}, area=${JSON.stringify(fallbackArea)}`);

          if (fallbackArea.width >= 200 && fallbackArea.height >= 200) {
            const chatRegion2 = this.extractRegion(rgbBuffer, bounds.width, bounds.height, fallbackArea);
            return await sharp(chatRegion2, {
              raw: { width: fallbackArea.width, height: fallbackArea.height, channels: 3 },
            }).png().toBuffer();
          }
        }

        return null;
      }

      logger.debug(`captureFullChatArea: chat area x=${chatArea.x}, y=${chatArea.y}, w=${chatArea.width}, h=${chatArea.height}`);

      const chatRegion = this.extractRegion(rgbBuffer, bounds.width, bounds.height, chatArea);
      const pngBuffer = await sharp(chatRegion, {
        raw: { width: chatArea.width, height: chatArea.height, channels: 3 },
      }).png().toBuffer();

      return pngBuffer;
    } catch (error) {
      logger.error('captureFullChatArea failed:', error);
      return null;
    }
  }
}

let capturer: ScreenshotCapturer | null = null;

export function getCapturer(): ScreenshotCapturer {
  if (!capturer) {
    capturer = new ScreenshotCapturer();
  }
  return capturer;
}
