/**
 * VLM Analysis Cycle
 * Periodically collects patrol screenshots and sends them to VLM in batch (no stitching).
 * Uses runId as idempotency unit - processes whole runs as atomic units.
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
  runId: number;   // numeric run id extracted from filename
  index: number;   // screenshot suffix/index extracted from filename (1,2,3...)
  mtime: number;    // for tie-break only
}

/**
 * Parse runId and screenshot index from screenshot filename
 * Format: patrol_<name>_<runId>_<suffix>.png
 * Example: patrol_n8n测试群_123456_1.png
 */
function parseRunAndIndex(filename: string): { runId: number; index: number } | null {
  const match = filename.match(/patrol_.+_(\d{6})_(\d+)\.png$/);
  if (!match) return null;

  const runId = Number(match[1]);
  const index = Number(match[2]);
  if (!Number.isFinite(runId) || !Number.isFinite(index)) return null;

  return { runId, index };
}

export class VlmCycle {
  private provider: VisionProvider;
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastProcessedRunId: Map<string, number> = new Map(); // targetName → runId watermark
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
      const parsed = parseRunAndIndex(file);
      if (!parsed) {
        logger.warn(`VLM cycle: could not parse runId/index from ${file}`);
        continue;
      }

      const filepath = path.join(patrolDir, file);
      const stats = fs.statSync(filepath);
      allScreenshots.push({
        filepath,
        runId: parsed.runId,
        index: parsed.index,
        mtime: stats.mtimeMs,
      });
    }

    // Sort: runId asc (older run first), index desc (older screenshot first within a run)
    // This ensures: old -> new order for processing
    allScreenshots.sort((a, b) => {
      if (a.runId !== b.runId) return a.runId - b.runId;
      if (a.index !== b.index) return b.index - a.index;
      return a.mtime - b.mtime;
    });

    if (allScreenshots.length === 0) {
      logger.debug(`VLM cycle: no valid screenshots for ${target.name}`);
      return;
    }

    // Filter: only process runs newer than last processed runId
    const lastRunId = this.lastProcessedRunId.get(target.name);
    const newScreenshots = lastRunId !== undefined
      ? allScreenshots.filter(s => s.runId > lastRunId)
      : allScreenshots;

    if (newScreenshots.length === 0) {
      logger.info(`VLM cycle: no new runs for ${target.name} (last runId: ${lastRunId})`);
      return;
    }

    logger.info(`VLM cycle: ${target.name} — ${newScreenshots.length} new screenshot(s) since runId ${lastRunId || 'beginning'}`);

    // Group screenshots by runId so we can process runs as idempotency units
    const runs = new Map<number, ScreenshotInfo[]>();
    for (const s of newScreenshots) {
      if (!runs.has(s.runId)) runs.set(s.runId, []);
      runs.get(s.runId)!.push(s);
    }

    // Ensure each run's screenshots are in correct order (old -> new)
    for (const [rid, arr] of runs.entries()) {
      arr.sort((a, b) => b.index - a.index); // higher index is older => old first
      runs.set(rid, arr);
    }

    // Process runs in ascending runId order
    const runIds = Array.from(runs.keys()).sort((a, b) => a - b);

    const BATCH_SIZE = 5;
    const OVERLAP = 1; // overlap 1 image between consecutive batches within a run

    for (const runId of runIds) {
      const screenshots = runs.get(runId)!;
      logger.info(`VLM cycle: ${target.name} — processing runId=${runId}, ${screenshots.length} screenshot(s)`);

      // Batch with overlap: [0..4], [4..8], [8..12]...
      for (let start = 0; start < screenshots.length; ) {
        const end = Math.min(start + BATCH_SIZE, screenshots.length);

        // Include overlap from previous batch (except first batch)
        const overlapStart = start === 0 ? 0 : Math.max(0, start - OVERLAP);
        const batch = screenshots.slice(overlapStart, end);

        try {
          await this.processBatch(target, batch);

          logger.debug(
            `VLM cycle: ${target.name} — runId=${runId} processed batch [${overlapStart}..${end - 1}] (overlap=${start === 0 ? 0 : OVERLAP})`
          );
        } catch (error) {
          logger.error(`VLM cycle: ${target.name} — runId=${runId} failed batch starting at index=${screenshots[start]?.index}:`, error);

          // On error: delete files in this attempted batch so next cycle can retry
          this.cleanupFiles(batch.map(s => s.filepath));
          return; // stop processing this target; do NOT advance watermark
        }

        // Advance start by (BATCH_SIZE - OVERLAP) after the first batch
        if (start === 0) {
          start = end;
        } else {
          start = end - OVERLAP;
        }
      }

      // Only after a full run is processed successfully, advance watermark
      this.lastProcessedRunId.set(target.name, runId);
      logger.info(`VLM cycle: ${target.name} — advanced lastProcessedRunId to ${runId}`);
    }
  }

  private async processBatch(target: { name: string; category: string }, batch: ScreenshotInfo[]): Promise<void> {
    // Batch is ordered from old -> new (chronological)
    // Overlap batches may include duplicate coverage intentionally

    const runId = batch[0]?.runId;
    const oldestIndex = batch[0]?.index;     // because old->new, first is older
    const newestIndex = batch[batch.length - 1]?.index; // last is newer

    // Save batch debug info
    const vlmDir = path.join(config.capture.screenshotDir, 'vlm');
    if (!fs.existsSync(vlmDir)) {
      fs.mkdirSync(vlmDir, { recursive: true });
    }
    const batchInfoPath = path.join(vlmDir, `vlm_${target.name}_${Date.now()}_batch.txt`);
    fs.writeFileSync(batchInfoPath, `Batch: ${batch.length} images\nTarget: ${target.name}\nrunId: ${runId}\nOrder: old -> new\nIndex range: ${oldestIndex} .. ${newestIndex}\nFiles:\n${batch.map(s => s.filepath).join('\n')}`);
    logger.debug(`VLM cycle: batch info saved to ${batchInfoPath}`);

    // Read all image buffers from batch
    const imageBuffers = batch.map(s => fs.readFileSync(s.filepath));

    // Build batch context - batch is ordered old -> new
    const batchContext: RecognizeContext = {
      targetName: target.name,
      category: target.category,
      batchInfo: {
        imageCount: batch.length,
        imageIndex: 0,
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
