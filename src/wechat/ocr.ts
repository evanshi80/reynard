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

  // Helper to extract lines from OCR result
  const extractLines = (resultData: any): Tesseract.Line[] => {
    const lines: Tesseract.Line[] = [];
    if (resultData.data.blocks) {
      for (const block of resultData.data.blocks) {
        for (const para of block.paragraphs) {
          for (const line of para.lines) {
            lines.push(line);
          }
        }
      }
    }
    return lines;
  };

  // First attempt: SPARSE_TEXT (PSM 11)
  await w.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT });
  let data = await w.recognize(pngBuffer, {}, { blocks: true });
  let allLines = extractLines(data);

  logger.debug(`OCR attempt 1 (SPARSE_TEXT): ${allLines.length} lines`);

  // Check if category found in first attempt
  let categoryY: number | null = null;
  for (const line of allLines) {
    const text = line.text.trim().replace(/\s+/g, '');
    if (isFuzzyMatch(text, categoryName)) {
      categoryY = Math.round(line.bbox.y0 / config.ocr.resizeScale);
      break;
    }
  }

  // Fallback: if not found, retry with SINGLE_BLOCK (PSM 6)
  if (categoryY === null) {
    logger.debug(`Category "${categoryName}" not found in first attempt, retrying with SINGLE_BLOCK...`);
    await w.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK });
    data = await w.recognize(pngBuffer, {}, { blocks: true });
    allLines = extractLines(data);
    logger.debug(`OCR attempt 2 (SINGLE_BLOCK): ${allLines.length} lines`);

    for (const line of allLines) {
      const text = line.text.trim().replace(/\s+/g, '');
      if (isFuzzyMatch(text, categoryName)) {
        categoryY = Math.round(line.bbox.y0 / config.ocr.resizeScale);
        break;
      }
    }
  }

  // Log all normalized OCR results for debugging
  logger.info('All OCR lines:');
  for (const line of allLines) {
    const normalized = line.text.trim().replace(/\s+/g, '');
    const origY = Math.round(line.bbox.y0 / config.ocr.resizeScale);
    logger.info(`   [y=${origY}] "${normalized}"`);
  }

  if (categoryY === null) {
    logger.warn(`Category "${categoryName}" not found after both OCR attempts`);
    return null;
  }

  // Build list of OCR lines with normalized text
  // Filter out noise (lines with very small y or very short text)
  const ocrLines = allLines
    .map(line => ({
      y: Math.round(line.bbox.y0 / config.ocr.resizeScale),
      text: line.text.trim().replace(/\s+/g, ''),
      rawText: line.text.trim(),
    }))
    .filter(line => line.y > 5 && line.text.length > 1) // Filter noise: y>5 and text>1 char
    .sort((a, b) => a.y - b.y);

  // Check first line to determine WeChat's selection state:
  // - If first line is "搜索网络结果" (search suggestion): WeChat has NO selection, Home lands on search suggestion
  // - If first line is a category (群聊/联系人): WeChat AUTO-SELECTED first result, Home lands on first result
  const firstLine = ocrLines[0];
  const isFirstLineSearchSuggestion = firstLine?.text.includes('搜索');
  const categoryNames = ['群聊', '联系人', '功能'];
  const isFirstLineCategory = firstLine ? categoryNames.some(cat => isFuzzyMatch(firstLine.text, cat)) : false;

  logger.info(`First line: "${firstLine?.text}", isSearchSuggestion=${isFirstLineSearchSuggestion}, isCategory=${isFirstLineCategory}`);

  // If first line is a category (WeChat auto-selected first result), no Down needed after Home
  if (isFirstLineCategory) {
    logger.info(`WeChat auto-selected first result, using 0 Down`);
    return { categoryY, downCount: 0 };
  }

  // If first line is search suggestion: Home lands on search suggestion
  // Need to count how many lines from first line to category, then skip all of them
  if (isFirstLineSearchSuggestion) {
    // Count lines between first line (search suggestion) and category
    const linesBeforeCategory = ocrLines.filter(line => line.y < categoryY);
    // Down count = number of search result lines (skip all + category to reach first result)
    const downCount = linesBeforeCategory.length;
    logger.info(`First line is search suggestion, ${linesBeforeCategory.length} lines before category, using ${downCount} Down`);
    return { categoryY, downCount };
  }

  // If category is at the very top (y < 50), it means WeChat already showed it at top
  // In this case, we likely only need 1 Down to get to the first result
  if (categoryY < 50) {
    logger.info(`Category "${categoryName}" at top (y=${categoryY}), using 1 Down`);
    return { categoryY, downCount: 1 };
  }

  // Find the first item AFTER the category (skip search suggestions and category header)
  // Category headers (群聊, 联系人, 功能) are not selectable - need to go to the item below
  // Use the same categoryNames defined above
  let firstItemY: number | null = null;

  for (let i = 0; i < ocrLines.length; i++) {
    const line = ocrLines[i];
    // Check if this line is a category header
    const isCategoryHeader = categoryNames.some(cat => isFuzzyMatch(line.text, cat));

    if (line.y > categoryY && isCategoryHeader) {
      // This is the next category, stop here
      break;
    }

    // Skip search suggestions (contains "搜索") and category headers
    const isSearchSuggestion = line.text.includes('搜索') || line.text.includes('搜一搜');

    if (line.y > categoryY && !isCategoryHeader && !isSearchSuggestion) {
      firstItemY = line.y;
      logger.info(`Found first item below category: y=${firstItemY}, text="${line.text}"`);
      break;
    }
  }

  if (firstItemY === null) {
    logger.warn(`No item found below category "${categoryName}"`);
    return { categoryY, downCount: 1 }; // fallback to 1 Down
  }

  // Calculate Down presses from first line to target item
  const firstLineY = ocrLines[0]?.y || 0;

  // Only calculate itemHeight from lines BEFORE categoryY (sidebar UI, not search results)
  // After categoryY there are search results which have different spacing
  const linesBeforeCategory = ocrLines.filter(line => line.y <= categoryY);
  const gaps: number[] = [];
  for (let i = 1; i < linesBeforeCategory.length; i++) {
    const gap = linesBeforeCategory[i].y - linesBeforeCategory[i - 1].y;
    if (gap > 0 && gap < 200) {
      gaps.push(gap);
    }
  }

  let itemHeight: number;
  if (gaps.length > 0) {
    gaps.sort((a, b) => a - b);
    const mid = Math.floor(gaps.length / 2);
    itemHeight = gaps.length % 2 === 0
      ? (gaps[mid - 1] + gaps[mid]) / 2
      : gaps[mid];
  } else {
    itemHeight = 50;
  }

  // Down count = distance from first line to first item, divided by item height
  // Subtract 1 because Home already selects the first item
  const distanceToTarget = firstItemY - firstLineY;
  const downCount = Math.max(0, Math.round(distanceToTarget / itemHeight) - 1);

  logger.info(`Category "${categoryName}": categoryY=${categoryY}, firstItemY=${firstItemY}, firstLineY=${firstLineY}, itemHeight=${itemHeight.toFixed(1)}, need ${downCount} Down presses`);
  return { categoryY, downCount };
}

/**
 * Fuzzy match for weekday recognition
 * Only triggers when there's an explicit weekday prefix like "周", "星期", "是期", "旺期"
 */
function parseWeekday(text: string): number | null {
  const clean = text.replace(/\s+/g, '');

  // Only match if there's an explicit weekday marker/prefix
  // Handles OCR errors: 是期三 / 旺期二 / 汪期二 / 星期三 / 周三
  const m = clean.match(/(星期|周|是期|旺期|汪期)([一二三四五六日天])/);
  if (!m) return null;

  const ch = m[2];
  switch (ch) {
    case '一': return 1;
    case '二': return 2;
    case '三': return 3;
    case '四': return 4;
    case '五': return 5;
    case '六': return 6;
    case '日':
    case '天': return 7;
    default: return null;
  }
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

  // Parse order: explicit dates first, then weekday as fallback
  // This prevents weekday from overwriting more reliable explicit dates

  // 1) YYYY/M/d or YYYY-M-d (full date) - highest priority
  const fullDateMatch = clean.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (fullDateMatch) {
    year = parseInt(fullDateMatch[1], 10);
    month = parseInt(fullDateMatch[2], 10);
    day = parseInt(fullDateMatch[3], 10);
  }

  // 2) M/d or M月d日 (month/day) - second priority
  if (month === undefined) {
    const dateMatch = clean.match(/(\d{1,2})[\/\月](\d{1,2})[\日]?/);
    if (dateMatch) {
      month = parseInt(dateMatch[1], 10);
      day = parseInt(dateMatch[2], 10);
    }
  }

  // 3) 昨天 / 昨日 (yesterday) - third priority
  if (month === undefined && (clean.includes('昨天') || clean.includes('昨日'))) {
    setYesterday();
  }

  // 4) Weekday - lowest priority, only if no explicit date found
  if (month === undefined) {
    const weekday = parseWeekday(clean);
    if (weekday !== null) {
      setWeekday(weekday);
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
  // Preprocess image for better OCR accuracy
  // First get image dimensions from the buffer
  const imageMeta = await sharp(imageBuffer).metadata();
  const imgWidth = imageMeta.width || 0;
  const imgHeight = imageMeta.height || 0;

  // Convert PNG to raw RGBA pixels for preprocessImage
  const rawPixels = await sharp(imageBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer();

  const preprocessed = await preprocessImage(rawPixels, imgWidth, imgHeight);

  const w = await getWorker();
  const { data } = await w.recognize(preprocessed, {}, { blocks: true });

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
