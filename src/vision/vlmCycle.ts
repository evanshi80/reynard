/**
 * VLM Analysis Cycle
 * Periodically collects patrol screenshots, stitches them, and sends to VLM for recognition.
 * Keeps a baseline image per target to only send incremental (new) content.
 */
import { config } from '../config';
import { createVisionProvider, VisionProvider } from './providers';
import { stitchImages, enforceMaxHeight, extractNewContent, isDuplicateImage } from './imageStitcher';
import { getMonitor } from '../capture/monitor';
import logger from '../utils/logger';
import fs from 'fs';
import path from 'path';

export class VlmCycle {
  private provider: VisionProvider;
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastProcessed: Map<string, number> = new Map(); // targetName → timestamp ms
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

  /** Get the file path for a target's baseline image */
  private getBaselinePath(target: { name: string }): string {
    const safeName = target.name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
    const baselineDir = path.join(config.capture.screenshotDir, 'baselines');
    if (!fs.existsSync(baselineDir)) {
      fs.mkdirSync(baselineDir, { recursive: true });
    }
    return path.join(baselineDir, `baseline_${safeName}.png`);
  }

  private async processTarget(target: { name: string; category: string }): Promise<void> {
    const patrolDir = path.join(config.capture.screenshotDir, 'patrol');
    if (!fs.existsSync(patrolDir)) return;

    const safeName = target.name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
    const prefix = `patrol_${safeName}_`;
    const lastTs = this.lastProcessed.get(target.name) || 0;

    // Scan for new screenshots matching this target
    const files = fs.readdirSync(patrolDir)
      .filter(f => f.startsWith(prefix) && f.endsWith('.png'))
      .sort(); // alphabetical = chronological (ISO timestamp)

    // Filter to only files newer than lastProcessed
    const newFiles: string[] = [];
    for (const file of files) {
      const filepath = path.join(patrolDir, file);
      const stat = fs.statSync(filepath);
      if (stat.mtimeMs > lastTs) {
        newFiles.push(filepath);
      }
    }

    if (newFiles.length === 0) {
      logger.debug(`VLM cycle: no new screenshots for ${target.name}`);
      return;
    }

    logger.info(`VLM cycle: ${target.name} — ${newFiles.length} new screenshot(s)`);

    // Read all PNG buffers
    const buffers = newFiles.map(f => fs.readFileSync(f));

    // Stitch new screenshots together
    let stitched = await stitchImages(buffers);

    // Check against baseline for incremental content
    const baselinePath = this.getBaselinePath(target);
    let imageToAnalyze: Buffer | null = stitched;

    if (fs.existsSync(baselinePath)) {
      const baseline = fs.readFileSync(baselinePath);
      const newContent = await extractNewContent(baseline, stitched);
      if (!newContent) {
        logger.info(`VLM cycle: ${target.name} — no new content vs baseline, skipping`);
        // Still update lastProcessed and cleanup raw screenshots
        this.lastProcessed.set(target.name, Date.now());
        if (config.vlm.cleanupProcessed) {
          this.cleanupFiles(newFiles);
        }
        return;
      }
      imageToAnalyze = newContent;
      logger.info(`VLM cycle: ${target.name} — sending incremental content to VLM`);
    } else {
      logger.info(`VLM cycle: ${target.name} — first cycle, sending full image to VLM`);
    }

    // Save stitched as new baseline (always the full stitched image, not the delta)
    fs.writeFileSync(baselinePath, stitched);

    // Enforce max height
    imageToAnalyze = await enforceMaxHeight(imageToAnalyze, config.vlm.maxImageHeight);

    // Send to VLM with target context
    const result = await this.provider.recognize(imageToAnalyze, {
      targetName: target.name,
      category: target.category,
    });
    logger.info(`VLM cycle: ${target.name} — recognized ${result.messages?.length || 0} messages`);

    // Override roomName with config target name
    result.roomName = target.name;

    // Process messages (dedup + save + webhook)
    const monitor = getMonitor();
    await monitor.processMessages(result);
    this.targetsProcessedCount++;

    // Update last processed timestamp
    this.lastProcessed.set(target.name, Date.now());

    // Cleanup processed screenshots (baselines are kept)
    if (config.vlm.cleanupProcessed) {
      this.cleanupFiles(newFiles);
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
