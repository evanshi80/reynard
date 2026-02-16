/**
 * VLM Analysis Cycle
 * Periodically collects patrol screenshots, stitches them, and sends to VLM for recognition.
 * Uses checkpoint time in filename to track progress and avoids reprocessing.
 * Updates checkpoint files after processing to sync OCR and VLM timestamps.
 */
import { config } from '../config';
import { createVisionProvider, VisionProvider } from './providers';
import { stitchImages, enforceMaxHeight } from './imageStitcher';
import { getMonitor } from '../capture/monitor';
import { saveCheckpoint, createCheckpointFromTimeStr, type Checkpoint } from '../bot/patrol';
import logger from '../utils/logger';
import fs from 'fs';
import path from 'path';

interface ScreenshotInfo {
  filepath: string;
  checkpointTime: string; // Format: YYYYMMDD_HHmm
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
        allScreenshots.push({
          filepath: path.join(patrolDir, file),
          checkpointTime,
        });
      } else {
        logger.warn(`VLM cycle: could not parse checkpoint time from ${file}`);
      }
    }

    // Sort by checkpoint time (ascending - oldest first for stitching)
    allScreenshots.sort((a, b) => a.checkpointTime.localeCompare(b.checkpointTime));

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
      logger.debug(`VLM cycle: no new screenshots for ${target.name} (last checkpoint: ${lastCheckpoint})`);
      return;
    }

    logger.info(`VLM cycle: ${target.name} — ${newScreenshots.length} new screenshot(s) since ${lastCheckpoint || 'beginning'}`);

    // Process in batches if there are many accumulated screenshots
    const BATCH_SIZE = 5; // Max screenshots per batch
    const processedCheckpoints: string[] = [];

    for (let i = 0; i < newScreenshots.length; i += BATCH_SIZE) {
      const batch = newScreenshots.slice(i, i + BATCH_SIZE);
      const batchCheckpointTimes = batch.map(s => s.checkpointTime);

      try {
        await this.processBatch(target, batch);
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

  private async processBatch(target: { name: string; category: string }, batch: ScreenshotInfo[]): Promise<void> {
    // Read all PNG buffers from batch
    const buffers = batch.map(s => fs.readFileSync(s.filepath));

    // Stitch batch screenshots together
    let stitched = await stitchImages(buffers);

    // Enforce max height
    stitched = await enforceMaxHeight(stitched, config.vlm.maxImageHeight);

    // Send to VLM with target context
    const result = await this.provider.recognize(stitched, {
      targetName: target.name,
      category: target.category,
    });
    logger.info(`VLM cycle: ${target.name} (batch) — recognized ${result.messages?.length || 0} messages`);

    // Override roomName with config target name
    result.roomName = target.name;

    // Process messages (dedup + save + webhook)
    const monitor = getMonitor();
    await monitor.processMessages(result);
    this.targetsProcessedCount++;

    // Update checkpoint with screenshot's timestamp (from OCR), not VLM's time
    // The screenshot filename already has the correct date from OCR
    if (batch.length > 0) {
      // Use the newest screenshot's checkpoint time
      const newestScreenshot = batch[batch.length - 1];
      const checkpointTime = newestScreenshot.checkpointTime; // Format: YYYYMMDD_HHmm
      // Convert "20260211_2143" to "2/11 21:43" for parsing
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
