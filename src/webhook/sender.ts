import axios, { AxiosError } from 'axios';
import { WebhookPayload } from '../types';
import { config } from '../config';
import logger from '../utils/logger';
import { sleep } from '../utils/delay';

const MAX_RETRIES = 3;
const RETRY_DELAY_BASE = 1000; // 1 second
const REQUEST_TIMEOUT = 5000; // 5 seconds

/**
 * Send a webhook with retry logic
 */
export async function sendWebhook(payload: WebhookPayload, retries: number = 0): Promise<void> {
  if (!config.webhook.enabled || !config.webhook.url) {
    return;
  }

  try {
    logger.debug(`Sending webhook for message ${payload.messageId} (attempt ${retries + 1}/${MAX_RETRIES + 1})`);

    const response = await axios.post(config.webhook.url, payload, {
      timeout: REQUEST_TIMEOUT,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Reynard-Bot/1.0',
      },
    });

    logger.info(`Webhook sent successfully for message ${payload.messageId}, status: ${response.status}`);
  } catch (error) {
    const axiosError = error as AxiosError;

    // Log error details
    if (axiosError.response) {
      logger.error(
        `Webhook failed for message ${payload.messageId}: HTTP ${axiosError.response.status}`,
        axiosError.response.data
      );
    } else if (axiosError.request) {
      logger.error(`Webhook failed for message ${payload.messageId}: No response received`, axiosError.message);
    } else {
      logger.error(`Webhook failed for message ${payload.messageId}:`, axiosError.message);
    }

    // Retry logic with exponential backoff
    if (retries < MAX_RETRIES) {
      const delay = RETRY_DELAY_BASE * Math.pow(2, retries);
      logger.info(`Retrying webhook in ${delay}ms (attempt ${retries + 2}/${MAX_RETRIES + 1})`);
      await sleep(delay);
      return sendWebhook(payload, retries + 1);
    }

    // Max retries reached
    logger.error(`Webhook failed after ${MAX_RETRIES + 1} attempts for message ${payload.messageId}`);
    throw error;
  }
}

/**
 * Test the webhook endpoint
 */
export async function testWebhook(): Promise<boolean> {
  if (!config.webhook.url) {
    logger.warn('Webhook URL not configured');
    return false;
  }

  try {
    const testPayload: WebhookPayload = {
      messageId: 'test-message-id',
      roomId: 'test-room-id',
      roomName: 'Test Room',
      talkerId: 'test-talker-id',
      talkerName: 'Test User',
      content: 'This is a test message from Reynard Bot',
      messageType: 'text',
      timestamp: Date.now(),
    };

    await sendWebhook(testPayload);
    logger.info('Webhook test successful');
    return true;
  } catch (error) {
    logger.error('Webhook test failed', error);
    return false;
  }
}
