/**
 * VLM Analysis Cycle
 * Periodically collects patrol screenshots and sends them to VLM in batch (no stitching).
 * Uses checkpoint time in filename to track progress and avoids reprocessing.
 * Sends images separately with time order info and duplicate handling instructions.
 */
import { config } from '../config';
import { createVisionProvider, VisionProvider, RecognizeContext } from './providers';
import { getMonitor } from '../capture/monitor';
import { RecognizedMessage } from '../types';

type Message = {
  index: number;
  sender: string;
  content: string;
  time: string | null;
};
import logger from '../utils/logger';
import fs from 'fs';
import path from 'path';

interface ScreenshotInfo {
  filepath: string;
  orderInfo: string; // Format: runId_screenshotIndex (e.g., "123456_001")
  mtime: number; // File modification time (for ordering)
}

/**
 * Parse order info from screenshot filename
 * Format: patrol_<name>_<runId>_<suffix>.png
 * Example: patrol_n8n测试群_123456_001.png
 * Returns runId_suffix for sorting
 */
function parseOrderInfo(filename: string): string | null {
  // Match pattern: patrol_<name>_<runId>_<suffix>.png
  const match = filename.match(/patrol_.+_(\d{6})_(\d+)\.png$/);
  if (match) {
    // Return runId_screenshotIndex for sorting
    return `${match[1]}_${String(parseInt(match[2])).padStart(3, '0')}`;
  }
  return null;
}

/**
 * Compare order info chronologically
 * Returns true if a > b (for finding newest)
 */
function isOrderNewer(a: string, b: string): boolean {
  // Format: runId_screenshotIndex (e.g., "123456_001")
  // Can compare as strings since they sort lexicographically
  return a > b;
}

export class VlmCycle {
  private provider: VisionProvider;
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastProcessedCheckpoint: Map<string, string> = new Map(); // targetName → orderInfo
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
      const orderInfo = parseOrderInfo(file);
      if (orderInfo) {
        const filepath = path.join(patrolDir, file);
        const stats = fs.statSync(filepath);
        allScreenshots.push({
          filepath,
          orderInfo,
          mtime: stats.mtimeMs,
        });
      } else {
        logger.warn(`VLM cycle: could not parse checkpoint time from ${file}`);
      }
    }

    // Sort by checkpoint time (ascending - oldest first)
    // Checkpoint time format: YYYYMMDD_HHmm - sortable as string
    // This ensures correct chronological order regardless of file modification time
    allScreenshots.sort((a, b) => a.orderInfo.localeCompare(b.orderInfo));

    if (allScreenshots.length === 0) {
      logger.debug(`VLM cycle: no valid screenshots for ${target.name}`);
      return;
    }

    // Filter to only screenshots newer than last processed checkpoint
    const lastCheckpoint = this.lastProcessedCheckpoint.get(target.name);
    const newScreenshots = lastCheckpoint
      ? allScreenshots.filter(s => s.orderInfo > lastCheckpoint)
      : allScreenshots;

    if (newScreenshots.length === 0) {
      logger.info(`VLM cycle: no new screenshots for ${target.name} (last checkpoint: ${lastCheckpoint})`);
      return;
    }

    logger.info(`VLM cycle: ${target.name} — ${newScreenshots.length} new screenshot(s) since ${lastCheckpoint || 'beginning'}`);

    // Process in batches if there are many accumulated screenshots
    const BATCH_SIZE = 5; // Max screenshots per batch
    const processedCheckpoints: string[] = [];

    for (let i = 0; i < newScreenshots.length; i += BATCH_SIZE) {
      const batch = newScreenshots.slice(i, i + BATCH_SIZE);
      const batchCheckpointTimes = batch.map(s => s.orderInfo);

      try {
        await this.processBatch(target, batch);
        // Mark all batch checkpoints as processed
        processedCheckpoints.push(...batchCheckpointTimes);
        logger.debug(`VLM cycle: ${target.name} — processed batch ${Math.floor(i / BATCH_SIZE) + 1} (checkpoints: ${batchCheckpointTimes.join(', ')})`);
      } catch (error) {
        logger.error(`VLM cycle: ${target.name} — failed to process batch starting at checkpoint ${batch[0].orderInfo}:`, error);
        // On error, delete screenshots for retry on next cycle
        this.cleanupFiles(batch.map(s => s.filepath));
        break;
      }
    }

    // Update last processed checkpoint to the newest one processed
    if (processedCheckpoints.length > 0) {
      const newestCheckpoint = processedCheckpoints.reduce((a, b) => isOrderNewer(a, b) ? a : b);
      this.lastProcessedCheckpoint.set(target.name, newestCheckpoint);
      logger.info(`VLM cycle: ${target.name} — updated checkpoint to ${newestCheckpoint}`);
    }
  }

  private async processBatch(target: { name: string; category: string }, batch: ScreenshotInfo[]): Promise<void> {
    // Helper to convert checkpoint time to display format
    const getTimeStr = (orderInfo: string): string | undefined => {
      const match = orderInfo.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/);
      if (match) {
        return `${parseInt(match[2])}/${parseInt(match[3])} ${match[4]}:${match[5]}`;
      }
      return undefined;
    };

    // Get time range for the batch
    const earliestCheckpoint = batch[0]?.orderInfo;
    const latestCheckpoint = batch[batch.length - 1]?.orderInfo;
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
      // No referenceTime - let VLM figure out timestamps from images
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
    };

    // Process messages (save + webhook)
    const monitor = getMonitor();
    await monitor.processMessages(finalResult);
    this.targetsProcessedCount++;

    // Note: Checkpoint is saved by patrol, not VLM
    // VLM should NOT overwrite checkpoint with derived timestamps

    // Cleanup processed screenshots
    if (config.vlm.cleanupProcessed) {
      this.cleanupFiles(batch.map(s => s.filepath));
    }
  }

  /**
   * Deduplicate messages based on content similarity
   * Uses normalized content as primary key, ignores minor time differences
   */
  private deduplicateMessages(messages: Message[]): Message[] {
    if (messages.length === 0) return [];

    const seen = new Map<string, Message>();
    const result: Message[] = [];

    for (const msg of messages) {
      // Normalize content: remove all whitespace and lowercase
      const contentNorm = msg.content.replace(/\s+/g, '').toLowerCase();

      // Skip empty content
      if (!contentNorm) continue;

      // Use content as primary key - messages with same content are duplicates
      // even if time differs slightly
      if (!seen.has(contentNorm)) {
        seen.set(contentNorm, msg);
        result.push(msg);
      } else {
        // Keep the one with more complete info (prefer having sender and time)
        const existing = seen.get(contentNorm)!;
        if (!existing.sender && msg.sender) existing.sender = msg.sender;
        if (!existing.time && msg.time) existing.time = msg.time;
      }
    }

    // Fill in null timestamps by propagating the last known timestamp
    const filledMessages = this.fillNullTimestamps(result);
    // Normalize time tokens: unify "HH:mm" with "M/d HH:mm" or "M月d日 HH:mm"
    return this.normalizeTimeTokens(filledMessages);
  }

  /**
   * Normalize time tokens: if same HH:mm appears with and without date prefix,
   * unify to the longer form (e.g., "2月17日 14:27" wins over "14:27").
   */
  private normalizeTimeTokens(messages: Message[]): Message[] {
    // Build mapping: HH:mm -> longest time string seen for this HH:mm
    const timeMap = new Map<string, string>();

    for (const msg of messages) {
      if (!msg.time) continue;
      // Extract HH:mm from time string
      const match = msg.time.match(/(\d{1,2}:\d{2})$/);
      if (match) {
        const hm = match[1];
        const existing = timeMap.get(hm);
        // Keep the longer one
        if (!existing || (msg.time.length > existing.length)) {
          timeMap.set(hm, msg.time);
        }
      }
    }

    // Apply normalization
    for (const msg of messages) {
      if (!msg.time) continue;
      const match = msg.time.match(/(\d{1,2}:\d{2})$/);
      if (match) {
        const hm = match[1];
        const normalized = timeMap.get(hm);
        if (normalized && normalized !== msg.time) {
          msg.time = normalized;
        }
      }
    }

    return messages;
  }

  /**
   * Fill null timestamps by propagating known timestamps.
   * Pass 1: forward-fill from previous known time.
   * Pass 2: backward-fill leading nulls from the first known time below.
   */
  private fillNullTimestamps(messages: Message[]): Message[] {
    // Pass 1: forward fill
    let lastKnownTime: string | null = null;
    for (const msg of messages) {
      if (msg.time) {
        lastKnownTime = msg.time;
      } else if (lastKnownTime) {
        msg.time = lastKnownTime;
      }
    }

    // Pass 2: backward fill (helps leading nulls)
    let nextKnownTime: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.time) {
        nextKnownTime = msg.time;
      } else if (nextKnownTime) {
        msg.time = nextKnownTime;
      }
    }

    return messages;
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
