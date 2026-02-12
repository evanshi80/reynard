import { WebhookPayload } from '../types';
import { config } from '../config';
import { sendWebhook } from './sender';
import logger from '../utils/logger';

class WebhookQueue {
  private queue: WebhookPayload[] = [];
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  /**
   * Add a message to the webhook queue
   */
  enqueue(payload: WebhookPayload): void {
    if (!config.webhook.enabled || !config.webhook.url) {
      return;
    }

    this.queue.push(payload);
    logger.debug(`Webhook queued: ${payload.messageId}, queue size: ${this.queue.length}`);

    // Start timer if not already running
    if (!this.timer) {
      this.startTimer();
    }

    // Process immediately if batch size reached
    if (this.queue.length >= config.webhook.batchSize) {
      this.processBatch();
    }
  }

  /**
   * Start the batch processing timer
   */
  private startTimer(): void {
    this.timer = setInterval(() => {
      if (this.queue.length > 0) {
        this.processBatch();
      }
    }, config.webhook.batchInterval * 1000);
  }

  /**
   * Stop the batch processing timer
   */
  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Process the current batch of messages
   */
  private async processBatch(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;

    try {
      // Get batch to process
      const batch = this.queue.splice(0, config.webhook.batchSize);
      logger.info(`Processing webhook batch: ${batch.length} messages`);

      // Send batch (or individual messages based on webhook endpoint requirements)
      // For now, we'll send them individually to avoid complexity
      for (const payload of batch) {
        try {
          await sendWebhook(payload);
        } catch (error) {
          logger.error(`Failed to send webhook for message ${payload.messageId}`, error);
          // Don't re-queue failed messages to avoid infinite loops
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Flush all pending messages immediately
   */
  async flush(): Promise<void> {
    this.stopTimer();
    await this.processBatch();
  }

  /**
   * Get the current queue size
   */
  size(): number {
    return this.queue.length;
  }
}

// Create singleton instance
export const webhookQueue = new WebhookQueue();

// Flush queue on process exit
process.on('exit', () => {
  webhookQueue.flush();
});

process.on('SIGINT', async () => {
  await webhookQueue.flush();
});

process.on('SIGTERM', async () => {
  await webhookQueue.flush();
});
