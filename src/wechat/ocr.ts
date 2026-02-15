import Tesseract from 'tesseract.js';
import sharp from 'sharp';
import logger from '../utils/logger';
import { config } from '../config';

let worker: Tesseract.Worker | null = null;

/**
 * Fuzzy match: handle common OCR mistakes for category names
 */
function isFuzzyMatch(ocrText: string, target: string): boolean {
  if (ocrText === target) return true;

  // 群聊 → 群获、群了、群人
  if (target === '群聊' && ocrText.startsWith('群')) {
    const second = ocrText[1];
    if (['获', '了', '人', '友'].includes(second)) return true;
  }
  // 联系人 → 联系、人、联系人
  if (target === '联系人' && ocrText.startsWith('联系')) return true;
  // 功能 → 功能
  if (target === '功能' && ocrText.startsWith('功能')) return true;

  return false;
}

async function getWorker(): Promise<Tesseract.Worker> {
  if (!worker) {
    logger.info('Initializing Tesseract OCR...');
    worker = await Tesseract.createWorker('chi_sim', 1, {
      logger: (m) => {
        if (m.status === 'recognizing text') {
          logger.debug(`OCR progress: ${(m.progress * 100).toFixed(0)}%`);
        }
      }
    });
    // Set parameters for better Chinese OCR
    await worker.setParameters({
      tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT, // Mode 11 - sparse text
    });
    logger.info('Tesseract OCR ready');
  }
  return worker;
}

function captureRegion(x: number, y: number, width: number, height: number): { data: Buffer; w: number; h: number } {
  const robot = require('robotjs');
  const capture = robot.screen.capture(x, y, width, height);
  const img = capture.image;
  for (let i = 0; i < img.length; i += 4) {
    const b = img[i]; img[i] = img[i + 2]; img[i + 2] = b;
  }
  return { data: Buffer.from(img), w: capture.width, h: capture.height };
}

/**
 * Preprocess image for better OCR accuracy:
 * - Resize (configurable scale)
 * - Increase contrast (configurable)
 */
async function preprocessImage(rawPixels: Buffer, width: number, height: number): Promise<Buffer> {
  const scale = config.ocr.resizeScale;
  const contrast = config.ocr.contrastGain;
  const brightness = config.ocr.brightnessOffset;

  return await sharp(rawPixels, {
    raw: { width, height, channels: 4 },
  })
    .resize({ width: width * scale, height: height * scale, kernel: 'lanczos3' })
    .grayscale()
    .modulate({ saturation: 0.2 })
    .linear(contrast, brightness)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Find category header position
 */
export async function findCategoryPosition(
  categoryName: string,
  regionX: number,
  regionY: number,
  regionW: number,
  regionH: number,
  dpiScale: number = 1.0,
): Promise<{ categoryY: number; downCount: number } | null> {
  const physX = Math.round(regionX * dpiScale);
  const physY = Math.round(regionY * dpiScale);
  const physW = Math.round(regionW * dpiScale);
  const physH = Math.round(regionH * dpiScale);

  const { data: rawPixels, w: actualW, h: actualH } = captureRegion(physX, physY, physW, physH);

  // Preprocess image for better OCR
  const pngBuffer = await preprocessImage(rawPixels, actualW, actualH);

  const w = await getWorker();
  const { data } = await w.recognize(pngBuffer, {}, { blocks: true });

  const allLines: Tesseract.Line[] = [];
  if (data.blocks) {
    for (const block of data.blocks) {
      for (const para of block.paragraphs) {
        for (const line of para.lines) {
          allLines.push(line);
        }
      }
    }
  }

  // Log all normalized OCR results for debugging (debug level)
  logger.debug('All OCR text:');
  for (const line of allLines) {
    const normalized = line.text.trim().replace(/\s+/g, '');
    const origY = Math.round(line.bbox.y0 / config.ocr.resizeScale);
    logger.debug(`   "${line.text.trim()}" -> "${normalized}" y=${origY}`);
  }

  // Find category with fuzzy match
  let categoryY: number | null = null;

  for (const line of allLines) {
    const text = line.text.trim().replace(/\s+/g, '');
    if (isFuzzyMatch(text, categoryName)) {
      // Convert back to original coordinate system
      const origY = Math.round(line.bbox.y0 / config.ocr.resizeScale);
      categoryY = origY;
      logger.debug(`Found category "${categoryName}" (OCR: "${text}") at y=${origY} (bbox.y0=${line.bbox.y0})`);
      break;
    }
  }

  if (categoryY === null) {
    logger.warn(`Category "${categoryName}" not found`);
    return null;
  }

  // Calculate Down presses
  // Home selects first search result (often "搜一搜" or category header)
  // If category header is already selected, no Down needed
  // Otherwise, need to go from current position to target item
  const itemHeight = 50;
  // Down count = items from category header to target
  // If categoryY < itemHeight * 2, it's close to top (probably already on first item)
  const downCount = Math.max(0, Math.round(categoryY / itemHeight) - 1);

  logger.info(`Category "${categoryName}" at relY=${categoryY}, need ${downCount} Down presses`);
  return { categoryY, downCount };
}

/**
 * Fuzzy match for weekday recognition
 * Aggressive matching: any occurrence of weekday character is treated as weekday
 * Handles OCR errors like "是期三" -> "周三", "旺期二" -> "周二"
 */
function parseWeekday(text: string): number | null {
  const clean = text.replace(/\s+/g, '');

  // Character map: only actual weekday characters
  // OCR may produce: 周三, 星期三, 是期三, 旺期二,汪期二, etc.
  // All contain: 一二三四五六日天
  const charMap: { [key: string]: number } = {
    '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7,
  };

  // Aggressive: find ANY weekday character in the text
  for (const char of Object.keys(charMap)) {
    if (clean.includes(char)) {
      return charMap[char];
    }
  }

  return null;
}

/**
 * Parse timestamp from OCR text
 * Formats:
 * - 当日: HH:mm (e.g., "09:30", "21:45")
 * - 昨天/昨日: 昨天HH:mm / 昨日HH:mm
 * - 星期X: 周一/周二/周三/周四/周五/周六/周日 + HH:mm
 * - 历史: M/d HH:mm (e.g., "1/15 09:30", "12/25 21:30")
 * - 历史中文: M月d日 HH:mm (e.g., "1月15日 09:30", "12月25日 21:30")
 * - 完整日期: YYYY/M/d HH:mm (e.g., "2025/1/15 09:30")
 */
export function parseTimestamp(text: string): { hour: number; minute: number; month?: number; day?: number; year?: number } | null {
  // Remove all whitespace
  const clean = text.replace(/\s+/g, '');

  // Extract time first (required)
  const timeMatch = clean.match(/(\d{1,2}):(\d{2})/);
  if (!timeMatch) return null;

  const hour = parseInt(timeMatch[1], 10);
  const minute = parseInt(timeMatch[2], 10);

  // Validate hour range
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }

  // Extract date if present
  let month: number | undefined;
  let day: number | undefined;
  let year: number | undefined;

  // Helper to set date to yesterday
  const setYesterday = () => {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    year = yesterday.getFullYear();
    month = yesterday.getMonth() + 1;
    day = yesterday.getDate();
  };

  // Helper to set date to specific weekday (last occurrence, not today)
  const setWeekday = (weekdayNum: number) => {
    const now = new Date();
    // Convert: JS Sunday=0 → Chinese Sunday=7 (end of week), Monday=1 stays Monday
    const currentDay = now.getDay() === 0 ? 7 : now.getDay();
    const targetWeekday = weekdayNum === 0 ? 7 : weekdayNum;

    // Calculate days ago for this weekday
    let diff = currentDay - targetWeekday;
    if (diff <= 0) diff += 7; // If target is today or ahead, go back a week

    const targetDate = new Date(now);
    targetDate.setDate(now.getDate() - diff);

    year = targetDate.getFullYear();
    month = targetDate.getMonth() + 1;
    day = targetDate.getDate();
  };

  // 昨天 / 昨日 (yesterday)
  if (clean.includes('昨天') || clean.includes('昨日')) {
    setYesterday();
  }

  // 星期X (周一到周日) - with fuzzy matching for OCR errors
  const weekday = parseWeekday(clean);
  if (weekday !== null) {
    setWeekday(weekday);
  }

  // 星期1, 星期2, 星期N (numeric weekday)
  const weekdayNumMatch = clean.match(/星期([1-7])/);
  if (weekdayNumMatch) {
    setWeekday(parseInt(weekdayNumMatch[1], 10));
  }

  // 周1, 周2 (short numeric weekday)
  const weekNumMatch = clean.match(/^周([1-7])(\d{1,2}:\d{2})/);
  if (weekNumMatch) {
    setWeekday(parseInt(weekNumMatch[1], 10));
  }

  // YYYY/M/d or YYYY-M-d (full date) - only if not already set
  if (year === undefined) {
    const fullDateMatch = clean.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (fullDateMatch) {
      year = parseInt(fullDateMatch[1], 10);
      month = parseInt(fullDateMatch[2], 10);
      day = parseInt(fullDateMatch[3], 10);
    }
  }

  // M/d or M月d日 (month/day) - only if not already set
  if (year === undefined && month === undefined) {
    const dateMatch = clean.match(/(\d{1,2})[\/\月](\d{1,2})[\日]?/);
    if (dateMatch) {
      month = parseInt(dateMatch[1], 10);
      day = parseInt(dateMatch[2], 10);
    }
  }

  return { hour, minute, ...(month !== undefined && { month }), ...(day !== undefined && { day }), ...(year !== undefined && { year }) };
}

/**
 * Recognize timestamps from chat screenshot
 * Returns list of timestamps with their Y positions
 */
export async function recognizeTimestamps(
  imageBuffer: Buffer,
  width: number,
  height: number,
): Promise<Array<{ y: number; text: string; parsed: ReturnType<typeof parseTimestamp> }>> {
  const w = await getWorker();
  const { data } = await w.recognize(imageBuffer, {}, { blocks: true });

  const results: Array<{ y: number; text: string; parsed: ReturnType<typeof parseTimestamp> }> = [];

  // Extract text lines with position
  const allLines: Tesseract.Line[] = [];
  if (data.blocks) {
    for (const block of data.blocks) {
      for (const para of block.paragraphs) {
        for (const line of para.lines) {
          allLines.push(line);
        }
      }
    }
  }

  // Check each line for timestamp pattern
  for (const line of allLines) {
    const text = line.text.trim().replace(/\s+/g, '');
    const parsed = parseTimestamp(text);
    if (parsed) {
      // Normalize Y position
      const y = Math.round(line.bbox.y0 / config.ocr.resizeScale);
      results.push({ y, text, parsed });
      logger.debug(`Found timestamp: "${text}" at y=${y}`);
    }
  }

  // Sort by Y position (top to bottom)
  results.sort((a, b) => a.y - b.y);

  return results;
}

/**
 * Cleanup
 */
export async function terminateOcr(): Promise<void> {
  if (worker) {
    await worker.terminate();
    worker = null;
  }
}
