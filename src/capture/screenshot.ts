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
   * Detect chat area boundary by analyzing image
   * WeChat has two panels: left (chat history list) and right (current chat area)
   * The boundary is usually a vertical separator line or a color change
   */
  private detectChatAreaBoundary(imageBuffer: Buffer, width: number, height: number): number {
    // Sample columns from left to right and look for the separator
    // The separator is typically a thin vertical line with different color
    const startX = Math.floor(width * 0.15); // Start searching from 15% of width
    const endX = Math.floor(width * 0.5); // Chat area is usually in the right half

    const separatorCandidates: { x: number; score: number }[] = [];

    // Analyze each column for separator characteristics
    for (let x = startX; x < endX; x++) {
      let verticalVariance = 0;
      let darkPixelCount = 0;
      const samplePoints = Math.min(20, height);

      // Sample vertical column
      for (let y = 0; y < samplePoints; y++) {
        const idx = (y * width + x) * 3;
        const prevIdx = (y * width + Math.max(0, x - 2)) * 3;

        const r = imageBuffer[idx];
        const g = imageBuffer[idx + 1];
        const b = imageBuffer[idx + 2];

        const prevR = imageBuffer[prevIdx];
        const prevG = imageBuffer[prevIdx + 1];
        const prevB = imageBuffer[prevIdx + 2];

        // Detect vertical line: darker than neighbors
        const brightness = (r + g + b) / 3;
        const prevBrightness = (prevR + prevG + prevB) / 3;

        if (brightness < 50 && brightness < prevBrightness * 0.8) {
          darkPixelCount++;
        }

        // Calculate vertical continuity
        if (y > 0) {
          const prevIdx2 = ((y - 1) * width + x) * 3;
          const prevBright = (imageBuffer[prevIdx2] + imageBuffer[prevIdx2 + 1] + imageBuffer[prevIdx2 + 2]) / 3;
          verticalVariance += Math.abs(brightness - prevBright);
        }
      }

      // High score if column has many dark pixels (separator line)
      // and good vertical continuity
      const darkRatio = darkPixelCount / samplePoints;
      if (darkRatio > 0.3) {
        separatorCandidates.push({ x, score: darkRatio * 100 - verticalVariance * 0.1 });
      }
    }

    // Find the best candidate
    if (separatorCandidates.length > 0) {
      separatorCandidates.sort((a, b) => b.score - a.score);
      const bestX = separatorCandidates[0].x;
      logger.debug(`Detected chat area boundary at x=${bestX}`);
      return bestX;
    }

    // Fallback: use percentage-based estimation (chat area typically starts at ~20-25%)
    const fallbackX = Math.floor(width * 0.22);
    logger.debug(`Using fallback boundary at x=${fallbackX}`);
    return fallbackX;
  }

  /**
   * Detect the chat content area within the right panel
   * Includes the chat group name header at the top
   */
  private detectChatContentArea(imageBuffer: Buffer, width: number, height: number, chatStartX: number): { x: number; y: number; width: number; height: number } {
    // Include header (group name) at top, start from very top or minimal padding
    const contentStartY = 0;

    // Chat input area at bottom, typically last 100-150 pixels
    const inputAreaHeight = Math.floor(height * 0.12);
    const contentHeight = height - contentStartY - inputAreaHeight;

    return {
      x: chatStartX + 10, // Small padding from separator
      y: contentStartY,
      width: width - chatStartX - 20,
      height: contentHeight,
    };
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

      // Convert BGRA → RGB (3 channels, matching detectChatAreaBoundary expectations)
      const rgbBuffer = Buffer.alloc(bounds.width * bounds.height * 3);
      for (let i = 0; i < bounds.width * bounds.height; i++) {
        rgbBuffer[i * 3] = rawPixels[i * 4];
        rgbBuffer[i * 3 + 1] = rawPixels[i * 4 + 1];
        rgbBuffer[i * 3 + 2] = rawPixels[i * 4 + 2];
      }

      // Detect chat area boundary via pixel analysis
      const chatStartX = this.detectChatAreaBoundary(rgbBuffer, bounds.width, bounds.height);
      const chatArea = this.detectChatContentArea(rgbBuffer, bounds.width, bounds.height, chatStartX);

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
