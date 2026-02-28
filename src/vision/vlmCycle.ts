/**
 * VLM Analysis Cycle
 * Periodically collects patrol screenshots and sends them to VLM in batch (no stitching).
 * Uses checkpoint time in filename to track progress and avoids reprocessing.
 * Sends images separately with time order info and duplicate handling instructions.
 */
import { config } from '../config';
import { createVisionProvider, VisionProvider, RecognizeContext } from './providers';
import { getMonitor } from '../capture/monitor';
import { saveCheckpoint, createCheckpointFromTimeStr, type Checkpoint } from '../bot/patrol';
import { RecognizedMessage } from '../types';

type Message = {
  index: number;
  sender: string;
  content: string;
  time: string;
};
import logger from '../utils/logger';
import fs from 'fs';
import path from 'path';

interface ScreenshotInfo {
  filepath: string;
  checkpointTime: string; // Format: YYYYMMDD_HHmm
  mtime: number; // File modification time (for ordering)
}

/**
 * Parse checkpoint time from screenshot filename
 * Format: patrol_<name>_YYYYMMDD_HHmm_<suffix>.png
 * Returns null if parsing fails
 */
function parseCheckpointTime(filename: string): string | null {
  // Match pattern: patrol_<name>_YYYYMMDD_HHm_<suffix>.png
  // Example: patrol_开发群_20260212_2135_1.png
  const match = filename.match(/patrol_.+_(\d{8}_\d{4})_\d+\.png$/);
  return match ? match[1] : null;
}

/**
 * Compare checkpoint times chronologically
 * Returns true if a > b
 */
function isCheckpointNewer(a: string, b: string): boolean {
  // Format: YYYYMMDD_HHmm
  // Can compare as strings since they sort lexicographically
  return a > b;
}

export class VlmCycle {
  private provider: VisionProvider;
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastProcessedCheckpoint: Map<string, string> = new Map(); // targetName → checkpointTime
  private lastCycleTime: string | null = null;
  private targetsProcessedCount = 0;

  constructor() {
    this.provider = createVisionProvider();
  }

  start(): void {
    if (this.isRunning) {
      logger.warn('VLM cycle already running');
      return;
    }

    this.isRunning = true;
    logger.info(`VLM cycle started (interval: ${config.vlm.cycleInterval}ms, cleanup: ${config.vlm.cleanupProcessed})`);

    // Schedule first run after one interval (give patrol time to produce screenshots)
    this.scheduleNext();
  }

  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info('VLM cycle stopped');
  }

  getStatus(): { running: boolean; lastCycle: string | null; targetsProcessed: number } {
    return {
      running: this.isRunning,
      lastCycle: this.lastCycleTime,
      targetsProcessed: this.targetsProcessedCount,
    };
  }

  private scheduleNext(): void {
    if (!this.isRunning) return;
    this.timer = setTimeout(async () => {
      if (!this.isRunning) return;
      await this.runCycle();
      this.scheduleNext();
    }, config.vlm.cycleInterval);
  }

  private async runCycle(): Promise<void> {
    const targets = config.bot.targets;
    if (!targets || targets.length === 0) {
      logger.debug('VLM cycle: no targets configured');
      return;
    }

    logger.info('VLM cycle: starting analysis...');
    const cycleStart = Date.now();

    for (const target of targets) {
      try {
        await this.processTarget(target);
      } catch (error) {
        logger.error(`VLM cycle: error processing ${target.name}:`, error);
      }
    }

    this.lastCycleTime = new Date().toISOString();
    logger.info(`VLM cycle complete (${Date.now() - cycleStart}ms)`);
  }

  private async processTarget(target: { name: string; category: string }): Promise<void> {
    const patrolDir = path.join(config.capture.screenshotDir, 'patrol');
    if (!fs.existsSync(patrolDir)) return;

    const safeName = target.name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
    const prefix = `patrol_${safeName}_`;

    // Read and parse all screenshots for this target
    const allScreenshots: ScreenshotInfo[] = [];
    const files = fs.readdirSync(patrolDir)
      .filter(f => f.startsWith(prefix) && f.endsWith('.png'));

    for (const file of files) {
      const checkpointTime = parseCheckpointTime(file);
      if (checkpointTime) {
        const filepath = path.join(patrolDir, file);
        const stats = fs.statSync(filepath);
        allScreenshots.push({
          filepath,
          checkpointTime,
          mtime: stats.mtimeMs,
        });
      } else {
        logger.warn(`VLM cycle: could not parse checkpoint time from ${file}`);
      }
    }

    // Sort by file modification time (ascending - oldest first)
    // Screenshots are taken from new to old (scroll up), so first file = newest message
    // For stitching: oldest (first scroll) should be at TOP, newest (last scroll) at BOTTOM
    // So we sort ascending by mtime: first = oldest = top of chat
    allScreenshots.sort((a, b) => a.mtime - b.mtime);

    if (allScreenshots.length === 0) {
      logger.debug(`VLM cycle: no valid screenshots for ${target.name}`);
      return;
    }

    // Filter to only screenshots newer than last processed checkpoint
    const lastCheckpoint = this.lastProcessedCheckpoint.get(target.name);
    const newScreenshots = lastCheckpoint
      ? allScreenshots.filter(s => s.checkpointTime > lastCheckpoint)
      : allScreenshots;

    if (newScreenshots.length === 0) {
      logger.info(`VLM cycle: no new screenshots for ${target.name} (last checkpoint: ${lastCheckpoint})`);
      return;
    }

    logger.info(`VLM cycle: ${target.name} — ${newScreenshots.length} new screenshot(s) since ${lastCheckpoint || 'beginning'}`);

    // Process in batches if there are many accumulated screenshots
    const BATCH_SIZE = 5; // Max screenshots per batch
    const processedCheckpoints: string[] = [];
    // For timestamp inheritance across batches: track the last timestamp from previous batch
    let previousBatchLastTimestamp: string | undefined = undefined;

    for (let i = 0; i < newScreenshots.length; i += BATCH_SIZE) {
      const batch = newScreenshots.slice(i, i + BATCH_SIZE);
      const batchCheckpointTimes = batch.map(s => s.checkpointTime);

      try {
        await this.processBatch(target, batch, previousBatchLastTimestamp);
        // Update previousBatchLastTimestamp for next batch (use the newest checkpoint in this batch)
        previousBatchLastTimestamp = batch[batch.length - 1]?.checkpointTime;
        // Mark all batch checkpoints as processed
        processedCheckpoints.push(...batchCheckpointTimes);
        logger.debug(`VLM cycle: ${target.name} — processed batch ${Math.floor(i / BATCH_SIZE) + 1} (checkpoints: ${batchCheckpointTimes.join(', ')})`);
      } catch (error) {
        logger.error(`VLM cycle: ${target.name} — failed to process batch starting at checkpoint ${batch[0].checkpointTime}:`, error);
        // On error, delete screenshots for retry on next cycle
        this.cleanupFiles(batch.map(s => s.filepath));
        break;
      }
    }

    // Update last processed checkpoint to the newest one processed
    if (processedCheckpoints.length > 0) {
      const newestCheckpoint = processedCheckpoints.reduce((a, b) => isCheckpointNewer(a, b) ? a : b);
      this.lastProcessedCheckpoint.set(target.name, newestCheckpoint);
      logger.info(`VLM cycle: ${target.name} — updated checkpoint to ${newestCheckpoint}`);
    }
  }

  private async processBatch(target: { name: string; category: string }, batch: ScreenshotInfo[], previousBatchLastTimestamp?: string): Promise<void> {
    // Helper to convert checkpoint time to display format
    const getTimeStr = (checkpointTime: string): string | undefined => {
      const match = checkpointTime.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/);
      if (match) {
        return `${parseInt(match[2])}/${parseInt(match[3])} ${match[4]}:${match[5]}`;
      }
      return undefined;
    };

    // Get time range for the batch
    const earliestCheckpoint = batch[0]?.checkpointTime;
    const latestCheckpoint = batch[batch.length - 1]?.checkpointTime;
    const earliestTime = earliestCheckpoint && earliestCheckpoint !== '00000000_0000'
      ? getTimeStr(earliestCheckpoint) || '未知'
      : '未知';
    const latestTime = latestCheckpoint && latestCheckpoint !== '00000000_0000'
      ? getTimeStr(latestCheckpoint) || '未知'
      : '未知';

    // Save batch debug info
    const vlmDir = path.join(config.capture.screenshotDir, 'vlm');
    if (!fs.existsSync(vlmDir)) {
      fs.mkdirSync(vlmDir, { recursive: true });
    }
    const batchInfoPath = path.join(vlmDir, `vlm_${target.name}_${Date.now()}_batch.txt`);
    fs.writeFileSync(batchInfoPath, `Batch: ${batch.length} images\nEarliest: ${earliestTime}\nLatest: ${latestTime}\nFiles:\n${batch.map(s => s.filepath).join('\n')}`);
    logger.info(`VLM cycle: batch info saved to ${batchInfoPath}`);

    // Read all image buffers from batch
    const imageBuffers = batch.map(s => fs.readFileSync(s.filepath));

    // Build batch context for time order and duplicate handling
    const batchContext: RecognizeContext = {
      targetName: target.name,
      category: target.category,
      referenceTime: previousBatchLastTimestamp ? getTimeStr(previousBatchLastTimestamp) : undefined,
      batchInfo: {
        imageCount: batch.length,
        imageIndex: 0, // Not used for batch send
        earliestTime,
        latestTime,
      },
    };

    // Send all images to VLM in one call
    const result = await this.provider.recognize(imageBuffers, batchContext);
    logger.info(`VLM cycle: ${target.name} (${batch.length} images) — recognized ${result.messages?.length || 0} messages`);

    // Deduplicate messages locally as fallback (in case VLM missed it)
    const dedupedMessages = this.deduplicateMessages(result.messages || []);
    logger.info(`VLM cycle: ${target.name} — ${result.messages?.length || 0} messages, ${dedupedMessages.length} after dedup`);

    // Create result object
    const finalResult: RecognizedMessage = {
      roomName: target.name,
      messages: dedupedMessages,
      referenceTime: latestTime !== '未知' ? latestTime : undefined,
    };

    // Process messages (save + webhook)
    const monitor = getMonitor();
    await monitor.processMessages(finalResult);
    this.targetsProcessedCount++;

    // Update checkpoint with screenshot's timestamp (from OCR)
    const validScreenshots = batch.filter(s => s.checkpointTime !== '00000000_0000');
    if (validScreenshots.length > 0) {
      const newestScreenshot = validScreenshots[validScreenshots.length - 1];
      const checkpointTime = newestScreenshot.checkpointTime;
      const parsed = checkpointTime.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/);
      if (parsed) {
        const timeStr = `${parseInt(parsed[2])}/${parseInt(parsed[3])} ${parsed[4]}:${parsed[5]}`;
        const checkpoint = createCheckpointFromTimeStr(timeStr, Date.now());
        saveCheckpoint(target.name, checkpoint);
        logger.debug(`VLM cycle: ${target.name} — updated checkpoint to ${checkpoint.timeStr}`);
      }
    }

    // Cleanup processed screenshots
    if (config.vlm.cleanupProcessed) {
      this.cleanupFiles(batch.map(s => s.filepath));
    }
  }

  /**
   * Deduplicate messages based on sender, content, and time similarity
   */
  private deduplicateMessages(messages: Message[]): Message[] {
    if (messages.length === 0) return [];

    const seen = new Map<string, Message>();
    const result: Message[] = [];

    for (const msg of messages) {
      // Create a key from sender + content (normalized)
      const contentNorm = msg.content.replace(/\s+/g, '').toLowerCase();
      const key = `${msg.sender || ''}:${msg.time || ''}:${contentNorm}`;

      if (!seen.has(key)) {
        seen.set(key, msg);
        result.push(msg);
      } else {
        // Keep the one with more complete info
        const existing = seen.get(key)!;
        if (!existing.sender && msg.sender) existing.sender = msg.sender;
        if (!existing.time && msg.time) existing.time = msg.time;
      }
    }

    return result;
  }

  private cleanupFiles(files: string[]): void {
    for (const filepath of files) {
      try {
        fs.unlinkSync(filepath);
      } catch (err) {
        logger.warn(`Failed to delete processed screenshot: ${filepath}`, err);
      }
    }
    logger.debug(`VLM cycle: cleaned up ${files.length} screenshots`);
  }
}

// Singleton
let vlmCycle: VlmCycle | null = null;

export function getVlmCycle(): VlmCycle {
  if (!vlmCycle) {
    vlmCycle = new VlmCycle();
  }
  return vlmCycle;
}
