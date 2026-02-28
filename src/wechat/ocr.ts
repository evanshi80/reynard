import Tesseract from 'tesseract.js';
import sharp from 'sharp';
import logger from '../utils/logger';
import { config } from '../config';
import fs from 'fs';
import path from 'path';

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
    // Set default parameters for better Chinese OCR
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
 * Parse timestamp from OCR text
 * Formats:
 * - 当日: HH:mm (e.g., "09:30", "21:45")
 * - 昨天/昨日: 昨天HH:mm / 昨日HH:mm
 * - 星期X: 周一/周二/周三/周四/周五/周六/周日 + HH:mm
 * - 历史: M/d HH:mm (e.g., "1/15 09:30", "12/25 21:30")
 * - 历史中文: M月d日 HH:mm (e.g., "1月15日 09:30", "12月25日 21:30")
 * - 完整日期: YYYY/M/d HH:mm (e.g., "2025/1/15 09:30")
 */

/**
 * Gate function: check if a line looks like a timestamp before parsing.
 * This filters out chat content that happens to contain numbers.
 */
function looksLikeTimestampLine(clean: string): boolean {
  // Must contain time structure (H:MM) - minute must be exactly 2 digits
  // (?!\d) prevents "21:200" from matching
  if (!/(\d{1,2})[:：](\d{2})(?!\d)/.test(clean)) return false;

  // Timestamps are usually short - reject long strings (likely chat content)
  if (clean.length > 20) return false;

  // Must have at least one date indicator or be just time
  const hasDateIndicator = /[月日号昨昨天今周星期]/.test(clean);
  const isJustTime = /^\d{1,2}[:]\d{2}$/.test(clean);

  return hasDateIndicator || isJustTime;
}

/**
 * Grammar whitelist patterns for timestamp parsing.
 * Each pattern includes a parser function that extracts date/time components.
 */
type TimestampParser = (clean: string) => { hour: number; minute: number; month?: number; day?: number; year?: number } | null;

const timestampPatterns: Array<{ name: string; re: RegExp; parse: TimestampParser }> = [
  // YYYY/M/d HH:mm or YYYY-M-d HH:mm
  {
    name: 'full date',
    re: /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})[^\d]*(\d{1,2})[:：](\d{2})(?!\d)/,
    parse: function(clean: string) {
      const m = this.re.exec(clean);
      if (!m) return null;
      return {
        year: parseInt(m[1], 10),
        month: parseInt(m[2], 10),
        day: parseInt(m[3], 10),
        hour: parseInt(m[4], 10),
        minute: parseInt(m[5], 10),
      };
    }
  },
  // M月d日 HH:mm (Chinese date format)
  {
    name: 'M月d日',
    re: /^(\d{1,2})月(\d{1,2})[日号][^\d]*(\d{1,2})[:：](\d{2})(?!\d)/,
    parse: function(clean: string) {
      const m = this.re.exec(clean);
      if (!m) return null;
      return {
        month: parseInt(m[1], 10),
        day: parseInt(m[2], 10),
        hour: parseInt(m[3], 10),
        minute: parseInt(m[4], 10),
      };
    }
  },
  // M/d HH:mm (numeric date format)
  {
    name: 'M/d',
    re: /^(\d{1,2})\/(\d{1,2})[^\d]*(\d{1,2})[:：](\d{2})(?!\d)/,
    parse: function(clean: string) {
      const m = this.re.exec(clean);
      if (!m) return null;
      return {
        month: parseInt(m[1], 10),
        day: parseInt(m[2], 10),
        hour: parseInt(m[3], 10),
        minute: parseInt(m[4], 10),
      };
    }
  },
  // Yesterday: 昨天 HH:mm or 昨日 HH:mm
  {
    name: 'yesterday',
    re: /^(昨天|昨日)[^\d]*(\d{1,2})[:：](\d{2})(?!\d)/,
    parse: function(clean: string) {
      const m = this.re.exec(clean);
      if (!m) return null;
      const now = new Date();
      const yesterday = new Date(now);
      yesterday.setDate(now.getDate() - 1);
      return {
        year: yesterday.getFullYear(),
        month: yesterday.getMonth() + 1,
        day: yesterday.getDate(),
        hour: parseInt(m[2], 10),
        minute: parseInt(m[3], 10),
      };
    }
  },
  // Weekday: 周X HH:mm or 星期X HH:mm
  {
    name: 'weekday',
    re: /^(周|星期)([一二三四五六日天])[^\d]*(\d{1,2})[:：](\d{2})(?!\d)/,
    parse: function(clean: string) {
      const m = this.re.exec(clean);
      if (!m) return null;
      const weekdayMap: Record<string, number> = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };
      const targetWeekday = weekdayMap[m[2]];
      if (!targetWeekday) return null;

      const now = new Date();
      const currentDay = now.getDay() === 0 ? 7 : now.getDay();
      let diff = currentDay - targetWeekday;
      if (diff <= 0) diff += 7;

      const targetDate = new Date(now);
      targetDate.setDate(now.getDate() - diff);

      return {
        year: targetDate.getFullYear(),
        month: targetDate.getMonth() + 1,
        day: targetDate.getDate(),
        hour: parseInt(m[3], 10),
        minute: parseInt(m[4], 10),
      };
    }
  },
  // Just time: HH:mm (today)
  {
    name: 'time only',
    re: /^(\d{1,2})[:：](\d{2})(?!\d)$/,
    parse: function(clean: string) {
      const m = this.re.exec(clean);
      if (!m) return null;
      return {
        hour: parseInt(m[1], 10),
        minute: parseInt(m[2], 10),
      };
    }
  },
];

export function parseTimestamp(text: string): { hour: number; minute: number; month?: number; day?: number; year?: number } | null {
  // Remove all whitespace
  let clean = text.replace(/\s+/g, '');

  // First gate: check if line looks like a timestamp
  if (!looksLikeTimestampLine(clean)) {
    return null;
  }

  // Grammar whitelist: try each pattern in priority order
  for (const pattern of timestampPatterns) {
    const result = pattern.parse.call({ re: pattern.re }, clean);
    if (result && result.hour >= 0 && result.hour <= 23 && result.minute >= 0 && result.minute <= 59) {
      // Validate month/day ranges
      if (result.month !== undefined && (result.month < 1 || result.month > 12)) continue;
      if (result.day !== undefined && (result.day < 1 || result.day > 31)) continue;
      return result;
    }
  }

  return null;
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
  const meta = await sharp(imageBuffer).metadata();
  const imgW = meta.width || 0;
  const imgH = meta.height || 0;
  if (!imgW || !imgH) return [];

  // Debug: ensure debug directory exists
  const debugDir = 'data/ocr_debug';
  if (config.ocr.debugArtifacts && !fs.existsSync(debugDir)) {
    fs.mkdirSync(debugDir, { recursive: true });
  }

  // 1) Crop to center strip (timestamps are centered; bubbles are left/right)
  const cropLeft = Math.floor(imgW * 0.25);
  const cropWidth = Math.floor(imgW * 0.5);

  const cropped = await sharp(imageBuffer)
    .extract({ left: cropLeft, top: 0, width: cropWidth, height: imgH })
    .toBuffer();

  // Save cropped debug image
  if (config.ocr.debugArtifacts) {
    const ts = Date.now();
    await sharp(cropped).png().toFile(path.join(debugDir, `ts_cropped_${ts}.png`));
    logger.debug(`[OCR debug] Saved cropped image: ts_cropped_${ts}.png`);
  }

  // 2) Preprocess specifically for faint gray timestamp text
  const preprocessed = await sharp(cropped)
    .ensureAlpha()
    .resize({ width: cropWidth * 2, height: imgH * 2, kernel: 'lanczos3' }) // upscale 2x
    .grayscale()
    .normalize()     // expand contrast automatically
    .sharpen()
    .png({ compressionLevel: 9 })
    .toBuffer();

  // Save preprocessed debug image
  if (config.ocr.debugArtifacts) {
    const ts = Date.now();
    await sharp(preprocessed).png().toFile(path.join(debugDir, `ts_preprocessed_${ts}.png`));
    logger.debug(`[OCR debug] Saved preprocessed image: ts_preprocessed_${ts}.png`);
  }

  const w = await getWorker();

  // Character whitelist for timestamps - must match parseTimestamp patterns
  const TS_WHITELIST =
    '0123456789:年月日昨天今日周星期一二三四五六日天';

  // Configure worker for timestamp OCR: PSM 11 (sparse text) + no dictionary
  await w.setParameters({
    tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT, // PSM 11 - better for sparse timestamps
    tessedit_char_whitelist: TS_WHITELIST,
    load_system_dawg: '0', // Disable dictionary to prevent "correction" of broken chars
    load_freq_dawg: '0',
  });

  // First pass: try preprocessed image
  let { data } = await w.recognize(preprocessed, {}, { blocks: true });

  // Count how many timestamps we parsed from first pass
  let parsedCount = 0;
  if (data.blocks) {
    for (const block of data.blocks) {
      for (const para of block.paragraphs) {
        for (const line of para.lines) {
          const text = line.text.trim().replace(/\s+/g, '');
          if (parseTimestamp(text)) parsedCount++;
        }
      }
    }
  }

  // Fallback: if first pass found nothing, try binarized image
  if (parsedCount === 0) {
    logger.info('[OCR timestamp] Pass A parsedCount=0, retrying with binarized pass B');

    // Create binarized image for faint timestamps
    const binarized = await sharp(cropped)
      .ensureAlpha()
      .resize({ width: cropWidth * 3, height: imgH * 3, kernel: 'lanczos3' }) // 3x upscale
      .grayscale()
      .linear(2.2, -110) // Strong contrast stretch
      .threshold(180)    // Binarize
      .png({ compressionLevel: 9 })
      .toBuffer();

    // Save binarized debug image
    if (config.ocr.debugArtifacts) {
      const ts = Date.now();
      await sharp(binarized).png().toFile(path.join(debugDir, `ts_binarized_${ts}.png`));
      logger.debug(`[OCR debug] Saved binarized image: ts_binarized_${ts}.png`);
    }

    ({ data } = await w.recognize(binarized, {}, { blocks: true }));
  }

  const results: Array<{ y: number; text: string; parsed: ReturnType<typeof parseTimestamp> }> = [];

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

  // Log all raw OCR lines for debugging
  logger.info(`[OCR timestamp] Raw lines count: ${allLines.length}`);
  for (const line of allLines) {
    const rawText = line.text.trim();
    const cleanedText = rawText.replace(/\s+/g, '');
    const yPos = Math.round(line.bbox.y0 / 2); // scale=2
    logger.info(`[OCR raw] y=${yPos}: "${rawText}" -> cleaned: "${cleanedText}"`);
  }

  // IMPORTANT: bbox is in the CROPPED+SCALED coordinate space.
  // We only need relative order, but for logging we map back to original roughly.
  const scale = 2; // we resized 2x

  // Group OCR fragments by y proximity and merge them
  type OcrFrag = { y: number; x: number; text: string };

  const frags: OcrFrag[] = allLines
    .map((line) => ({
      y: Math.round(line.bbox.y0 / scale),
      x: Math.round(line.bbox.x0),
      text: line.text.trim().replace(/\s+/g, ''),
    }))
    .filter(f => f.text.length > 0);

  // Group fragments by y proximity (same visual row)
  const Y_TOL = 8; // tolerance in pixels
  const groups: Array<{ y: number; items: OcrFrag[] }> = [];

  for (const f of frags.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const g = groups.length ? groups[groups.length - 1] : null;
    if (!g || Math.abs(f.y - g.y) > Y_TOL) {
      groups.push({ y: f.y, items: [f] });
    } else {
      // Merge into current group; keep group's y as running average
      g.items.push(f);
      g.y = Math.round((g.y * (g.items.length - 1) + f.y) / g.items.length);
    }
  }

  // Build merged candidate lines and parse
  for (const g of groups) {
    const merged = g.items
      .sort((a, b) => a.x - b.x)
      .map(i => i.text)
      .join('');

    // Try candidates: first the heuristic-recovered version, then raw merged
    const candidates: string[] = [merged];

    // Token-aware recovery: use OCR token boundaries to recover "M月D日"
    // This avoids the bug where "21120:54" gets wrongly split as "21月12日0:54"
    const tokens = g.items
      .sort((a, b) => a.x - b.x)
      .map(i => i.text);

    const timeTokenIdx = tokens.findIndex(t => /^(\d{1,2})[:：](\d{2})(?!\d)$/.test(t));

    if (timeTokenIdx >= 0) {
      const timeTok = tokens[timeTokenIdx];

      // Case: ["2","11","20:54"] -> "2月11日20:54"
      const mTok = tokens[timeTokenIdx - 2];
      const dTok = tokens[timeTokenIdx - 1];

      if (mTok && dTok && /^\d{1,2}$/.test(mTok) && /^\d{1,2}$/.test(dTok)) {
        candidates.unshift(`${mTok}月${dTok}日${timeTok}`);
      }

      // Optional: ["2","月","11","日","20:54"] or with "号"
      if (timeTokenIdx >= 4) {
        const m2 = tokens[timeTokenIdx - 4];
        const sep1 = tokens[timeTokenIdx - 3];
        const d2 = tokens[timeTokenIdx - 2];
        const sep2 = tokens[timeTokenIdx - 1];

        if (m2 && sep1 && d2 && sep2 &&
            /^\d{1,2}$/.test(m2) && sep1 === '月' &&
            /^\d{1,2}$/.test(d2) && (sep2 === '日' || sep2 === '号')) {
          candidates.unshift(`${m2}月${d2}${sep2}${timeTok}`);
        }
      }
    }

    for (const text of candidates) {
      const parsed = parseTimestamp(text);
      if (parsed) {
        results.push({ y: g.y, text, parsed });
        logger.info(`[OCR timestamp] merged "${text}" at y=${g.y} -> parsed: ${JSON.stringify(parsed)}`);
        break; // stop at first successful candidate
      }
    }
  }

  results.sort((a, b) => a.y - b.y);

  // Restore default parameters for category search (next OCR call)
  // Note: load_system_dawg/freq_dawg can only be set at init, so we only reset PSM and whitelist
  await w.setParameters({
    tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT,
    tessedit_char_whitelist: '',
  });

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
