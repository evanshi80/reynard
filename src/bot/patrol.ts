/**
 * Patrol Module
 * Periodically navigates to configured targets and captures screenshots
 */
import { config } from '../config';
import logger from '../utils/logger';
import { activateWeChat, navigateToResult, typeSearch, withAhkLock, sendMessage } from '../wechat/ahkBridge';
import { getCapturer } from '../capture/screenshot';
import { recognizeTimestamps } from '../wechat/ocr';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

// Track which targets have been greeted
const greetedTargets = new Set<string>();

// Track last patrol timestamp per target for scroll position
const lastPatrolTime: Map<string, number> = new Map();

// Checkpoint file for timestamps
export const CHECKPOINT_DIR = path.join(config.capture.screenshotDir, 'checkpoints');

export interface Checkpoint {
  timestamp: number;  // Unix timestamp when checkpoint was saved
  timeStr: string;    // Last recognized time string (e.g., "21:35" or "1/15 21:35")
  epochMs: number;    // Absolute time in milliseconds for comparison
  year?: number;
  month?: number;
  day?: number;
  hour: number;
  minute: number;
}

export function getCheckpointPath(targetName: string): string {
  const safeName = targetName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
  return path.join(CHECKPOINT_DIR, `checkpoint_${safeName}.json`);
}

export function loadCheckpoint(targetName: string): Checkpoint | null {
  try {
    const filepath = getCheckpointPath(targetName);
    if (fs.existsSync(filepath)) {
      const data = JSON.parse(fs.readFileSync(filepath, 'utf-8')) as Checkpoint;
      logger.info(`Loaded checkpoint for ${targetName}: ${data.timeStr}`);
      return data;
    }
  } catch (error) {
    logger.warn(`Failed to load checkpoint for ${targetName}:`, error);
  }
  return null;
}

export function saveCheckpoint(targetName: string, checkpoint: Checkpoint): void {
  try {
    if (!fs.existsSync(CHECKPOINT_DIR)) {
      fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
    }
    const filepath = getCheckpointPath(targetName);
    fs.writeFileSync(filepath, JSON.stringify(checkpoint, null, 2));
    logger.info(`Saved checkpoint for ${targetName}: ${checkpoint.timeStr}`);
  } catch (error) {
    logger.warn(`Failed to save checkpoint for ${targetName}:`, error);
  }
}

/**
 * Fuzzy match weekday OCR errors
 * Handles "是期三" -> 周三, etc.
 * Aggressive matching: any occurrence of weekday character is treated as weekday
 */
function parseWeekdayForCheckpoint(text: string): number | null {
  const clean = text.replace(/\s+/g, '');

  // Character map: only actual weekday characters
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
 * Create a Checkpoint from VLM message time string
 * Handles: "HH:mm", "昨天 HH:mm", "周一 HH:mm", "M/d HH:mm", "M月d日 HH:mm"
 */
export function createCheckpointFromTimeStr(timeStr: string, timestamp: number): Checkpoint {
  // Clean the time string
  const clean = timeStr.replace(/\s+/g, ' ').trim();

  let month: number | undefined;
  let day: number | undefined;
  let year: number | undefined;
  let hour: number = 0;
  let minute: number = 0;

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentDay = now.getDay(); // 0=周日, 1=周一

  // Extract time first
  const timeMatch = clean.match(/(\d{1,2}):(\d{2})/);
  if (timeMatch) {
    hour = parseInt(timeMatch[1], 10);
    minute = parseInt(timeMatch[2], 10);
  }

  // Check for relative dates first (昨天/昨日, 星期X)
  if (clean.includes('昨天') || clean.includes('昨日')) {
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    year = yesterday.getFullYear();
    month = yesterday.getMonth() + 1;
    day = yesterday.getDate();
  }
  // 周一, 周二, etc. with fuzzy matching for OCR errors
  else if (clean.includes('周') || clean.includes('是期')) {
    const weekday = parseWeekdayForCheckpoint(clean);
    if (weekday !== null) {
      // Convert: JS Sunday=0 → Chinese Sunday=7 (end of week), Monday=1 stays Monday
      const currentDayChinese = currentDay === 0 ? 7 : currentDay;
      const targetWeekday = weekday === 0 ? 7 : weekday;

      let diff = currentDayChinese - targetWeekday;
      if (diff <= 0) diff += 7; // If target is today or ahead, go back a week

      const targetDate = new Date(now);
      targetDate.setDate(now.getDate() - diff);
      year = targetDate.getFullYear();
      month = targetDate.getMonth() + 1;
      day = targetDate.getDate();
      logger.debug(`[debug] Weekday parsed: ${weekday}, date: ${year}/${month}/${day}`);
    }
  }
  // Check for explicit date formats
  else {
    // YYYY/M/d or YYYY-M-d
    const fullDateMatch = clean.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (fullDateMatch) {
      year = parseInt(fullDateMatch[1], 10);
      month = parseInt(fullDateMatch[2], 10);
      day = parseInt(fullDateMatch[3], 10);
    } else {
      // M/d or M月d日
      const dateMatch = clean.match(/(\d{1,2})[\/\月](\d{1,2})/);
      if (dateMatch) {
        month = parseInt(dateMatch[1], 10);
        day = parseInt(dateMatch[2], 10);
        year = currentYear;
      }
    }
  }

  // Compute epochMs for comparison
  const y = year ?? now.getFullYear();
  const m = (month ?? (now.getMonth() + 1)) - 1;
  const d = day ?? now.getDate();
  const epochMs = new Date(y, m, d, hour, minute, 0, 0).getTime();

  return {
    timestamp,
    timeStr,
    epochMs,
    year,
    month,
    day,
    hour,
    minute,
  };
}

/**
 * Convert parsed timestamp into an absolute epoch time in ms.
 * If date parts are missing, assume "today" but keep it consistent.
 */
function toEpochMs(parsed: { year?: number; month?: number; day?: number; hour: number; minute: number }): number {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;  // 1-12
  const currentDay = now.getDate();

  const y = parsed.year ?? currentYear;
  const m = (parsed.month ?? currentMonth);  // keep as 1-12
  const d = parsed.day ?? currentDay;

  // Create date using local timezone (month is 0-based in JS Date)
  const dt = new Date(y, m - 1, d, parsed.hour, parsed.minute, 0, 0);
  const epoch = dt.getTime();

  logger.info(`[toEpochMs] parsed=${JSON.stringify(parsed)} => y=${y}, m=${m}, d=${d} => epoch=${epoch} (now=${now.getTime()})`);

  return epoch;
}

/**
 * Create checkpoint from parsed timestamp result
 */
function createCheckpointFromParsed(timeStr: string, parsed: { year?: number; month?: number; day?: number; hour: number; minute: number }): Checkpoint {
  return {
    timestamp: Date.now(),
    timeStr,
    epochMs: toEpochMs(parsed),
    year: parsed.year,
    month: parsed.month,
    day: parsed.day,
    hour: parsed.hour,
    minute: parsed.minute,
  };
}

/**
 * Compare two checkpoints by epochMs
 * Returns true if t1 is newer than t2
 */
function isNewer(t1: Checkpoint, t2: Checkpoint): boolean {
  return t1.epochMs > t2.epochMs;
}

/**
 * Find the newest timestamp from OCR results
 */
function findNewestTimestamp(
  results: Array<{ y: number; text: string; parsed: ReturnType<typeof import('../wechat/ocr').parseTimestamp> }>
): { y: number; checkpoint: Checkpoint } | null {
  if (results.length === 0) return null;

  let newest: { y: number; checkpoint: Checkpoint } | null = null;

  for (const r of results) {
    if (!r.parsed) continue;
    const cp = createCheckpointFromParsed(r.text, r.parsed);

    if (!newest || cp.epochMs > newest.checkpoint.epochMs) {
      newest = { y: r.y, checkpoint: cp };
    }
  }

  if (!newest) return null;

  logger.debug(`[findNewest] result: timeStr="${newest.checkpoint.timeStr}", epochMs=${newest.checkpoint.epochMs}`);
  return newest;
}

/**
 * Format checkpoint time for use in filename
 * Format: YYYYMMDD_HHmm (e.g., 20260212_2135)
 */
function formatCheckpointTimeForFilename(checkpoint: Checkpoint | undefined): string {
  if (!checkpoint) {
    // Return a placeholder that will sort before any valid checkpoint
    return '00000000_0000';
  }
  const year = checkpoint.year || new Date().getFullYear();
  const month = String(checkpoint.month || new Date().getMonth() + 1).padStart(2, '0');
  const day = String(checkpoint.day || new Date().getDate()).padStart(2, '0');
  const hour = String(checkpoint.hour || 0).padStart(2, '0');
  const minute = String(checkpoint.minute || 0).padStart(2, '0');
  return `${year}${month}${day}_${hour}${minute}`;
}

/**
 * Capture screenshot of current chat window
 * @param targetName - Target name for filename
 * @param suffix - Screenshot index suffix
 * @param checkpoint - Optional checkpoint time to include in filename
 */
async function captureCurrentChat(targetName: string, suffix: string, checkpoint?: Checkpoint): Promise<string | null> {
  try {
    const pngBuffer = await getCapturer().captureFullChatArea();
    if (!pngBuffer) {
      logger.warn('Could not capture chat area for patrol');
      return null;
    }

    const safeName = targetName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
    const patrolDir = path.join(config.capture.screenshotDir, 'patrol');

    if (!fs.existsSync(patrolDir)) {
      fs.mkdirSync(patrolDir, { recursive: true });
    }

    // Format checkpoint time for filename (or use placeholder if no checkpoint yet)
    const checkpointTime = formatCheckpointTimeForFilename(checkpoint);
    const filename = `patrol_${safeName}_${checkpointTime}_${suffix}.png`;
    const filepath = path.join(patrolDir, filename);

    fs.writeFileSync(filepath, pngBuffer);

    logger.info(`Screenshot: ${targetName} (${suffix}) checkpoint=${checkpointTime} -> ${filepath}`);
    return filepath;
  } catch (error) {
    logger.error('Failed to capture screenshot:', error);
    return null;
  }
}

/**
 * Navigate to a target and capture screenshots with timestamp-based checkpoint
 * Sends greeting on first visit only if enabled
 */
async function patrolTarget(target: { name: string; category: string }, win: { x: number; y: number; width: number; height: number }): Promise<boolean> {
  try {
    logger.info(`Patrol: ${target.name} (${target.category})`);

    // Check window still exists before any AHK operations
    const windowFinder = getCapturer().getWindowFinder();
    const currentWin = windowFinder.findWeChatWindow();
    if (!currentWin) {
      logger.warn(`WeChat window no longer exists, skipping ${target.name}`);
      return false;
    }

    // Load previous checkpoint
    const lastCheckpoint = loadCheckpoint(target.name);

    // Wrap entire AHK sequence in lock to prevent interleaving
    return await withAhkLock(async () => {
      // Re-check window before AHK operations
      const winBeforeAhk = windowFinder.findWeChatWindow();
      if (!winBeforeAhk) {
        logger.warn(`WeChat window disappeared before AHK operations for ${target.name}`);
        return false;
      }

      // Navigate to target
      logger.info(`[patrol] Calling typeSearch for: ${target.name}`);
      const searchResult = await typeSearch(target.name);
      logger.info(`[patrol] typeSearch result: ${searchResult.success}, message: ${searchResult.message}`);
      if (!searchResult.success) {
        logger.warn(`Failed to type search for ${target.name}, skipping...`);
        return false;
      }
      await new Promise(r => setTimeout(r, config.ocr.searchLoadWait));

      // Use OCR to find category position in sidebar (upper part only)
      const { findCategoryPosition } = await import('../wechat/ocr');
      const sidebarW = Math.min(Math.round(win.width * 0.35), 400);
      const dpi = windowFinder.getDpiScaleForLastWindow();

      // Capture only the top 300px of sidebar where categories are
      const result = await findCategoryPosition(
        target.category,
        win.x,
        win.y + 50,
        sidebarW,
        Math.min(win.height - 50, 300),  // Focus on upper sidebar
        dpi
      );

      const downCount = result ? result.downCount : 1; // fallback to 1 (Home lands on 搜一搜, need 1 Down to reach 群聊)
      logger.info(`Category found at relY=${result?.categoryY}, using ${downCount} Down presses`);

      // Navigate to result
      const navigateResult = await navigateToResult(target.name, downCount);
      if (!navigateResult.success) {
        logger.warn(`Failed to navigate to ${target.name}`);
        return false;
      }
      await new Promise(r => setTimeout(r, 300));

      // Import scroll functions (use smooth scrolling for better message coverage)
      const { scrollToTop, scrollUpSmooth } = await import('../wechat/ahkBridge');

      // Check window before scrolling
      const winBeforeScroll = windowFinder.findWeChatWindow();
      if (!winBeforeScroll) {
        logger.warn(`WeChat window disappeared before scrolling for ${target.name}`);
        return false;
      }

      // Scroll to bottom first (latest messages), pass window coordinates for dynamic click
      await scrollToTop(win.x, win.y, win.width, win.height);
      await new Promise(r => setTimeout(r, 300));

      // Re-activate window
      await activateWeChat();
      await new Promise(r => setTimeout(r, 200));

      // Capture and check timestamps
      let screenshotIndex = 0;
      let newestCheckpoint: Checkpoint | null = null;

      // Has CP: scroll until we reach it, but with hard limit to avoid infinite scroll
      // No CP (first patrol): max 10 scrolls
      const MAX_SCROLLS_NO_CP = 10;
      const HARD_MAX_SCROLLS = 50; // Hard limit even with old checkpoint
      const maxScrolls = lastCheckpoint ? HARD_MAX_SCROLLS : MAX_SCROLLS_NO_CP;

      // Track screenshots to detect duplicates (for detecting "stuck" state / reached top)
      const recentScreenshots: string[] = [];

      // Track if we're at the top (no more scrolling possible)
      let consecutiveNoChangeScreenshots = 0;
      const NO_CHANGE_THRESHOLD = 3; // Stop after 3 identical screenshots

      for (let scrollCount = 0; scrollCount < maxScrolls; scrollCount++) {
        // Check window before each scroll operation
        const winInLoop = windowFinder.findWeChatWindow();
        if (!winInLoop) {
          logger.warn(`WeChat window disappeared during patrol of ${target.name}`);
          break;
        }

        screenshotIndex++;
        const suffix = String(screenshotIndex);

        // Use the newest checkpoint found so far for naming (will be updated after OCR)
        const filepath = await captureCurrentChat(target.name, suffix, newestCheckpoint || undefined);

        if (!filepath) {
          logger.warn(`Failed to capture screenshot ${screenshotIndex}`);
          break;
        }

        // OCR recognize timestamps
        const pngBuffer = fs.readFileSync(filepath);
        const timestampResults = await recognizeTimestamps(pngBuffer, 0, 0);

        // Create fingerprint from full image content hash (for detecting stuck state)
        const imageHash = crypto.createHash('md5').update(pngBuffer).digest('hex');
        recentScreenshots.push(imageHash);

        // Keep only last 3 screenshots for comparison
        if (recentScreenshots.length > 3) {
          recentScreenshots.shift();
        }

        // Check for stuck state (screenshot content not changing after scroll)
        // This indicates we've reached the top and can't scroll further
        if (recentScreenshots.length >= 2) {
          const last = recentScreenshots[recentScreenshots.length - 1];
          const prev = recentScreenshots[recentScreenshots.length - 2];
          if (last === prev) {
            consecutiveNoChangeScreenshots++;
            logger.debug(`Screenshot unchanged (${consecutiveNoChangeScreenshots}/${NO_CHANGE_THRESHOLD}), may be at top`);
            if (consecutiveNoChangeScreenshots >= NO_CHANGE_THRESHOLD) {
              logger.info('Reached top of chat (screenshot unchanged), stopping...');
              break;
            }
          } else {
            consecutiveNoChangeScreenshots = 0;
          }
        }

        // Handle timestamp detection for checkpoint
        if (timestampResults.length > 0) {
          logger.debug(`OCR results: ${timestampResults.map(r => `"${r.text}" at y=${r.y}`).join(', ')}`);

          const newest = findNewestTimestamp(timestampResults);
          if (newest) {
            const { month, day, year } = newest.checkpoint;
            const dateStr = year ? `${year}/${month}/${day}` : (month ? `${month}/${day}` : 'today');
            logger.info(`Found timestamps: ${timestampResults.map(r => r.text).join(', ')} (newest: ${dateStr} ${newest.checkpoint.hour}:${String(newest.checkpoint.minute).padStart(2, '0')})`);

            // Track the newest timestamp
            if (!newestCheckpoint) {
              logger.debug(`[debug] Setting initial checkpoint: ${newest.checkpoint.timeStr}`);
              newestCheckpoint = newest.checkpoint;
            } else {
              const newer = isNewer(newest.checkpoint, newestCheckpoint);
              logger.debug(`[debug] isNewer(${newest.checkpoint.timeStr}, ${newestCheckpoint.timeStr}) = ${newer}`);
              if (newer) {
                newestCheckpoint = newest.checkpoint;
              }
            }

            // Check if we've reached the old checkpoint
            if (lastCheckpoint) {
              const reachedCheckpoint = timestampResults.some(r => {
                if (!r.parsed) return false;
                const cp = createCheckpointFromParsed(r.text, r.parsed);
                return !isNewer(cp, lastCheckpoint);
              });
              if (reachedCheckpoint) {
                if (scrollCount === 0) {
                  logger.info(`No new messages since checkpoint "${lastCheckpoint.timeStr}", done.`);
                  newestCheckpoint = lastCheckpoint;
                } else {
                  logger.info(`Reached checkpoint "${lastCheckpoint.timeStr}" after ${scrollCount} scrolls, done.`);
                }
                break;
              }
            }
          }
        } else {
          logger.debug(`No timestamps found in screenshot ${screenshotIndex} (scroll ${scrollCount})`);
        }

        // Scroll up for next screenshot
        const winBeforeScrollUp = windowFinder.findWeChatWindow();
        if (!winBeforeScrollUp) {
          logger.warn(`WeChat window disappeared before scrollUp for ${target.name}`);
          break;
        }
        // Use smooth scroll: 5 wheel clicks per scroll (~10-15 lines of text)
        // This is a balance between coverage and speed
        await scrollUpSmooth(5);
        await new Promise(r => setTimeout(r, 300));
      }

      // Save checkpoint
      if (newestCheckpoint) {
        saveCheckpoint(target.name, newestCheckpoint);
      } else if (lastCheckpoint) {
        // Keep old checkpoint if no new one found
        logger.info(`Keeping old checkpoint "${lastCheckpoint.timeStr}"`);
      } else {
        // No checkpoint at all - use current time as fallback
        const now = new Date();
        const fallbackCP: Checkpoint = {
          timestamp: Date.now(),
          timeStr: `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
          epochMs: now.getTime(),
          year: now.getFullYear(),
          month: now.getMonth() + 1,
          day: now.getDate(),
          hour: now.getHours(),
          minute: now.getMinutes(),
        };
        saveCheckpoint(target.name, fallbackCP);
        logger.info(`No timestamps found after ${screenshotIndex} screenshots, using current time as fallback: ${fallbackCP.timeStr}`);
      }

      // Record patrol timestamp
      lastPatrolTime.set(target.name, Date.now());

      // Send greeting on first visit only if greeting is enabled
      const targetKey = `${target.name}|${target.category}`;
      if (config.bot.greetingEnabled && !greetedTargets.has(targetKey)) {
        // Check window before sending message
        const winBeforeGreeting = windowFinder.findWeChatWindow();
        if (!winBeforeGreeting) {
          logger.warn(`WeChat window disappeared before greeting ${target.name}`);
          return true; // Still return true as patrol completed
        }
        await sendMessage(config.bot.greetingMessage);
        greetedTargets.add(targetKey);
        logger.info(`Greeting sent to ${target.name}`);
      }

      return true;
    });
  } catch (error) {
    logger.error(`Failed to patrol ${target.name}:`, error);
    return false;
  }
}

/**
 * Run a single patrol round
 * Returns true if at least one target was processed successfully
 */
export async function runPatrol(): Promise<boolean> {
  if (!config.bot.targets || config.bot.targets.length === 0) {
    logger.info('No patrol targets configured');
    return false;
  }

  // Check if text mode is enabled - use chat history extraction instead of screenshot patrol
  if (config.vision.extractMode === 'text') {
    logger.info('======================================');
    logger.info('  Patrol Round (Text Mode)...        ');
    logger.info('======================================');

    const { extractMessagesTextMode } = require('../capture/monitor');
    for (const target of config.bot.targets) {
      try {
        await extractMessagesTextMode(target.name, target.category);
      } catch (error) {
        logger.error(`Text mode patrol: error processing ${target.name}:`, error);
      }
    }
    logger.info('======================================');
    logger.info('  Patrol complete (text mode)        ');
    logger.info('======================================');
    return true; // Text mode is considered successful if it runs
  }

  logger.info('======================================');
  logger.info('       Patrol Round...                ');
  logger.info('======================================');

  // Try to activate WeChat first (can restore minimized windows)
  const activateResult = await activateWeChat();
  await new Promise(r => setTimeout(r, 300));

  // Then find the window (after activation, it should be visible)
  const windowFinder = getCapturer().getWindowFinder();
  const win = windowFinder.findWeChatWindow();

  if (!win) {
    logger.warn('WeChat window not found, skipping patrol round...');
    return false;
  }

  logger.info(`Found WeChat window: ${win.width}x${win.height} at (${win.x}, ${win.y})`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < config.bot.targets.length; i++) {
    const target = config.bot.targets[i];
    const ok = await patrolTarget(target, win);

    if (ok) {
      successCount++;
    } else {
      failCount++;
    }

    // Wait between targets
    if (i < config.bot.targets.length - 1) {
      await new Promise(r => setTimeout(r, config.patrol.targetDelay));
    }
  }

  logger.info('======================================');
  logger.info(`Patrol complete: ${successCount} success, ${failCount} failed`);
  logger.info('======================================');

  return successCount > 0;
}

// Patrol state
let patrolRunning = false;
let patrolTimer: NodeJS.Timeout | null = null;
let patrolRoundCount = 0;

/**
 * Start patrol loop
 */
export async function startPatrol(): Promise<void> {
  if (patrolRunning) {
    logger.warn('Patrol already running');
    return;
  }

  patrolRunning = true;
  patrolRoundCount = 0;
  const maxRounds = config.patrol.maxRounds;
  logger.info(`Starting patrol with interval: ${config.patrol.interval}ms (maxRounds: ${maxRounds || 'unlimited'}, greeting: ${config.bot.greetingEnabled ? 'enabled' : 'disabled'})`);

  // Run immediately - only count successful patrols towards max rounds
  const initialSuccess = await runPatrol();
  if (initialSuccess) patrolRoundCount++;

  // Schedule next runs using setTimeout to prevent overlap
  const scheduleNext = () => {
    if (!patrolRunning) return;
    if (maxRounds > 0 && patrolRoundCount >= maxRounds) {
      logger.info(`Reached max patrol rounds (${maxRounds}), stopping...`);
      stopPatrol();
      return;
    }
    patrolTimer = setTimeout(async () => {
      if (!patrolRunning) return;
      const success = await runPatrol();
      if (success) patrolRoundCount++;
      scheduleNext();
    }, config.patrol.interval);
  };
  scheduleNext();
}

export function stopPatrol(): void {
  patrolRunning = false;
  if (patrolTimer) {
    clearTimeout(patrolTimer);
    patrolTimer = null;
  }
  logger.info('Patrol stopped');
}

/**
 * Reset greeted status (for testing)
 */
export function resetGreetedStatus(): void {
  greetedTargets.clear();
}
