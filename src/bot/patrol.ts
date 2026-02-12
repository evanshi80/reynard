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

// Track which targets have been greeted
const greetedTargets = new Set<string>();

// Track last patrol timestamp per target for scroll position
const lastPatrolTime: Map<string, number> = new Map();

// Checkpoint file for timestamps
const CHECKPOINT_DIR = path.join(config.capture.screenshotDir, 'checkpoints');

interface Checkpoint {
  timestamp: number;  // Unix timestamp when checkpoint was saved
  timeStr: string;    // Last recognized time string (e.g., "21:35" or "1/15 21:35")
  year?: number;
  month?: number;
  day?: number;
  hour: number;
  minute: number;
}

function getCheckpointPath(targetName: string): string {
  const safeName = targetName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
  return path.join(CHECKPOINT_DIR, `checkpoint_${safeName}.json`);
}

function loadCheckpoint(targetName: string): Checkpoint | null {
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

function saveCheckpoint(targetName: string, checkpoint: Checkpoint): void {
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
 * Compare two timestamps to determine which is newer
 * Returns true if t1 is newer than t2
 */
function isNewer(t1: Checkpoint, t2: Checkpoint): boolean {
  // If t1 has no date, it's today → newer
  if (t1.month === undefined && t1.year === undefined) {
    if (t2.month === undefined && t2.year === undefined) {
      // Both are today, compare by time
      return t1.hour > t2.hour || (t1.hour === t2.hour && t1.minute > t2.minute);
    }
    // t2 has date (not today), t1 is today → t1 is newer
    return true;
  }

  // If t2 has no date, t1 is not today → t2 is newer
  if (t2.month === undefined && t2.year === undefined) {
    return false;
  }

  // Both have dates, compare chronologically
  const y1 = t1.year || new Date().getFullYear();
  const y2 = t2.year || new Date().getFullYear();

  if (y1 !== y2) return y1 > y2;
  if (t1.month !== undefined && t2.month !== undefined && t1.month !== t2.month) return t1.month > t2.month;
  if (t1.day !== undefined && t2.day !== undefined && t1.day !== t2.day) return t1.day > t2.day;

  // Same date, compare by time
  return t1.hour > t2.hour || (t1.hour === t2.hour && t1.minute > t2.minute);
}

/**
 * Find the newest timestamp from OCR results
 */
function findNewestTimestamp(
  results: Array<{ y: number; text: string; parsed: ReturnType<typeof import('../wechat/ocr').parseTimestamp> }>
): { y: number; checkpoint: Checkpoint } | null {
  if (results.length === 0) return null;

  const now = new Date();
  const currentYear = now.getFullYear();
  const todayMonth = now.getMonth() + 1;
  const todayDay = now.getDate();

  let newestResult: typeof results[0] | null = null;

  for (const result of results) {
    if (!result.parsed) continue;

    const { month, day: d, year, hour, minute } = result.parsed;

    if (newestResult === null) {
      newestResult = result;
    } else if (newestResult.parsed) {
      // Use isNewer comparison
      const t1: Checkpoint = {
        timestamp: 0,
        timeStr: result.text,
        month,
        day: d,
        year,
        hour,
        minute,
      };
      const t2: Checkpoint = {
        timestamp: 0,
        timeStr: newestResult.text,
        month: newestResult.parsed.month,
        day: newestResult.parsed.day,
        year: newestResult.parsed.year,
        hour: newestResult.parsed.hour,
        minute: newestResult.parsed.minute,
      };

      if (isNewer(t1, t2)) {
        newestResult = result;
      }
    }
  }

  if (!newestResult || !newestResult.parsed) return null;

  const { month, day: d, year, hour, minute } = newestResult.parsed;
  return {
    y: newestResult.y,
    checkpoint: {
      timestamp: Date.now(),
      timeStr: newestResult.text,
      month,
      day: d,
      year,
      hour,
      minute,
    },
  };
}

/**
 * Capture screenshot of current chat window
 */
async function captureCurrentChat(targetName: string, suffix?: string): Promise<string | null> {
  try {
    const pngBuffer = await getCapturer().captureFullChatArea();
    if (!pngBuffer) {
      logger.warn('Could not capture chat area for patrol');
      return null;
    }

    // Save screenshot
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = targetName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
    const filename = `patrol_${safeName}_${timestamp}${suffix ? '_' + suffix : ''}.png`;
    const patrolDir = path.join(config.capture.screenshotDir, 'patrol');

    if (!fs.existsSync(patrolDir)) {
      fs.mkdirSync(patrolDir, { recursive: true });
    }

    const filepath = path.join(patrolDir, filename);
    fs.writeFileSync(filepath, pngBuffer);

    logger.info(`Screenshot: ${targetName}${suffix ? ' (' + suffix + ')' : ''} -> ${filepath}`);
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
async function patrolTarget(target: { name: string; category: string }): Promise<boolean> {
  try {
    logger.info(`Patrol: ${target.name} (${target.category})`);

    // Load previous checkpoint
    const lastCheckpoint = loadCheckpoint(target.name);

    // Wrap entire AHK sequence in lock to prevent interleaving
    return await withAhkLock(async () => {
      // Navigate to target
      const searchResult = await typeSearch(target.name);
      if (!searchResult.success) {
        logger.warn(`Failed to type search for ${target.name}, skipping...`);
        return false;
      }
      await new Promise(r => setTimeout(r, config.ocr.searchLoadWait));

      // Find window via shared capturer's WindowFinder
      const windowFinder = getCapturer().getWindowFinder();
      const win = windowFinder.findWeChatWindow();
      if (!win) {
        logger.warn(`Could not find window for ${target.name}`);
        return false;
      }

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

      const downCount = result ? result.downCount : 2; // fallback to 2
      logger.info(`Category found at relY=${result?.categoryY}, using ${downCount} Down presses`);

      // Navigate to result
      const navigateResult = await navigateToResult(target.name, downCount);
      if (!navigateResult.success) {
        logger.warn(`Failed to navigate to ${target.name}`);
        return false;
      }
      await new Promise(r => setTimeout(r, 300));

      // Import scroll functions
      const { scrollToTop, scrollUp } = await import('../wechat/ahkBridge');

      // Scroll to bottom first (latest messages), pass window coordinates for dynamic click
      await scrollToTop(win.x, win.y, win.width, win.height);
      await new Promise(r => setTimeout(r, 300));

      // Re-activate window
      await activateWeChat();
      await new Promise(r => setTimeout(r, 200));

      // Capture and check timestamps
      let screenshotIndex = 0;
      let newestCheckpoint: Checkpoint | null = null;
      const MAX_SCROLLS = 10; // Safety limit

      for (let scrollCount = 0; scrollCount < MAX_SCROLLS; scrollCount++) {
        screenshotIndex++;
        const suffix = String(screenshotIndex);
        const filepath = await captureCurrentChat(target.name, suffix);

        if (!filepath) {
          logger.warn(`Failed to capture screenshot ${screenshotIndex}`);
          break;
        }

        // OCR recognize timestamps
        const pngBuffer = fs.readFileSync(filepath);
        const timestampResults = await recognizeTimestamps(pngBuffer, 0, 0);

        if (timestampResults.length > 0) {
          logger.debug(`OCR results: ${timestampResults.map(r => `"${r.text}" at y=${r.y}`).join(', ')}`);

          const newest = findNewestTimestamp(timestampResults);
          if (newest) {
            const { month, day, year } = newest.checkpoint;
            const dateStr = year ? `${year}/${month}/${day}` : (month ? `${month}/${day}` : 'today');
            logger.info(`Found timestamps: ${timestampResults.map(r => r.text).join(', ')} (newest: ${dateStr} ${newest.checkpoint.hour}:${String(newest.checkpoint.minute).padStart(2, '0')})`);

            // Check if we've reached the old checkpoint
            if (lastCheckpoint && newest.checkpoint.timeStr === lastCheckpoint.timeStr) {
              logger.info(`Reached previous checkpoint "${lastCheckpoint.timeStr}", stopping...`);
              newestCheckpoint = lastCheckpoint;
              break;
            }

            // Track the newest timestamp
            if (!newestCheckpoint || isNewer(newest.checkpoint, newestCheckpoint)) {
              newestCheckpoint = newest.checkpoint;
            }
          }
        } else {
          logger.debug('No timestamps found in screenshot');
        }

        // Check if we should continue scrolling
        if (lastCheckpoint) {
          // If we found the old checkpoint, we're done
          const foundOld = timestampResults.some(r => r.text === lastCheckpoint.timeStr);
          if (foundOld) {
            logger.info(`Found old checkpoint "${lastCheckpoint.timeStr}", stopping...`);
            break;
          }
        }

        // Stop if no timestamps found (probably at top of chat)
        if (timestampResults.length === 0 && scrollCount > 2) {
          logger.info('No timestamps found, reached top of chat');
          break;
        }

        // Scroll up for next screenshot
        if (scrollCount < MAX_SCROLLS - 1) {
          await scrollUp();
          await new Promise(r => setTimeout(r, 300));
        }
      }

      // Save checkpoint
      if (newestCheckpoint) {
        saveCheckpoint(target.name, newestCheckpoint);
      } else if (lastCheckpoint) {
        // Keep old checkpoint if no new one found
        logger.info(`Keeping old checkpoint "${lastCheckpoint.timeStr}"`);
      }

      // Record patrol timestamp
      lastPatrolTime.set(target.name, Date.now());

      // Send greeting on first visit only if greeting is enabled
      const targetKey = `${target.name}|${target.category}`;
      if (config.bot.greetingEnabled && !greetedTargets.has(targetKey)) {
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
 */
export async function runPatrol(): Promise<void> {
  if (!config.bot.targets || config.bot.targets.length === 0) {
    logger.info('No patrol targets configured');
    return;
  }

  logger.info('======================================');
  logger.info('       Patrol Round...                ');
  logger.info('======================================');

  // Activate WeChat first
  await activateWeChat();
  await new Promise(r => setTimeout(r, 300));

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < config.bot.targets.length; i++) {
    const target = config.bot.targets[i];
    const ok = await patrolTarget(target);

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

  // Run immediately
  await runPatrol();
  patrolRoundCount++;

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
      await runPatrol();
      patrolRoundCount++;
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
