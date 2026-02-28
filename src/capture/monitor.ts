import { config } from '../config';
import { RecognizedMessage } from '../types';
import { createVisionProvider } from '../vision/providers';
import { createCheckpointFromTimeStr } from '../bot/patrol';
import { saveMessage, messageExistsInRoom } from '../database/repositories/messageRepository';
import { webhookQueue } from '../webhook/queue';
import logger from '../utils/logger';
import { MonitorStatus } from '../types';

interface SeenMessage {
  roomName: string;
  sender: string;
  content: string;
  timestamp: number;
}

/**
 * Message Monitor
 * Handles message deduplication, persistence, and webhook dispatch.
 * Screenshot capture is now handled by patrol; VLM calls by VlmCycle.
 */
export class MessageMonitor {
  private provider: ReturnType<typeof createVisionProvider>;
  private seenMessages: Map<string, SeenMessage>;
  private status: MonitorStatus;

  constructor() {
    this.provider = createVisionProvider();
    this.seenMessages = new Map();
    this.status = {
      running: true,
      messagesCollected: 0,
      errors: 0,
    };
  }

  /**
   * Check if a room should be monitored
   * Returns true if MONITORED_ROOMS is empty (monitor all) or room matches
   */
  private shouldMonitorRoom(roomName: string): boolean {
    const monitoredRooms = config.monitoring.rooms;
    if (monitoredRooms.length === 0) {
      return true; // Monitor all rooms
    }

    // Check if room name contains any of the monitored room names
    return monitoredRooms.some(room => roomName.includes(room));
  }

  /**
   * Generate unique key for message deduplication
   */
  private getMessageKey(roomName: string, sender: string, content: string): string {
    return `${roomName}:${sender}:${content.substring(0, 50)}`;
  }

  /**
   * Check if message is a duplicate
   */
  private isDuplicate(key: string): boolean {
    const seen = this.seenMessages.get(key);
    if (!seen) return false;

    // Consider duplicate if within 5 seconds
    if (Date.now() - seen.timestamp < 5000) {
      return true;
    }

    // Remove old entry
    this.seenMessages.delete(key);
    return false;
  }

  /**
   * Process recognized messages — dedup, save to DB, queue webhooks.
   * Called by VlmCycle after VLM recognition.
   */
  async processMessages(result: RecognizedMessage): Promise<void> {
    if (!result.messages || result.messages.length === 0) {
      return;
    }

    // Filter by monitored rooms
    if (!this.shouldMonitorRoom(result.roomName)) {
      logger.debug(`Ignoring messages from room: ${result.roomName}`);
      return;
    }

    // Process each message - VLM now returns time for every message
    for (const msg of result.messages) {
      const key = this.getMessageKey(result.roomName, msg.sender, msg.content);

      if (this.isDuplicate(key)) {
        continue;
      }

      // Check database for duplicates (within last 1 minute)
      if (messageExistsInRoom(result.roomName, msg.content, 60000)) {
        logger.debug(`[dedup] Skipping duplicate message in DB: ${msg.content.substring(0, 30)}`);
        // Also mark as seen to avoid reprocessing
        this.seenMessages.set(key, { roomName: result.roomName, sender: msg.sender, content: msg.content, timestamp: Date.now() });
        continue;
      }

      // Save seen message
      this.seenMessages.set(key, {
        roomName: result.roomName,
        sender: msg.sender,
        content: msg.content,
        timestamp: Date.now(),
      });

      // Clean up old entries
      if (this.seenMessages.size > 1000) {
        const cutoff = Date.now() - 60000; // 1 minute
        for (const [k, v] of this.seenMessages.entries()) {
          if (v.timestamp < cutoff) {
            this.seenMessages.delete(k);
          }
        }
      }

      // Create message record
      // VLM may return null for time if it can't determine - use current time as fallback
      const msgTime = msg.time || '现在';

      let timestamp: number;
      const parseBaseTime = Date.now();
      const checkpoint = createCheckpointFromTimeStr(msgTime, parseBaseTime);
      logger.debug(`[timestamp] VLM time="${msgTime}", parsed: ${checkpoint.year}/${checkpoint.month}/${checkpoint.day} ${checkpoint.hour}:${checkpoint.minute}`);
      if (checkpoint.year && checkpoint.month && checkpoint.day) {
        timestamp = new Date(checkpoint.year, checkpoint.month - 1, checkpoint.day, checkpoint.hour, checkpoint.minute, 0, 0).getTime();
      } else {
        const capturedTime = this.status.lastCapture ? new Date(this.status.lastCapture) : new Date();
        timestamp = new Date(capturedTime.setHours(checkpoint.hour, checkpoint.minute, 0, 0)).getTime();
      }

      const messageRecord = {
        messageId: `vision_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        roomId: result.roomName,
        roomName: result.roomName,
        talkerId: msg.sender,
        talkerName: msg.sender,
        content: msg.content,
        messageType: 'text',
        timestamp,
        msgIndex: (msg as any).index || 0,
        rawData: JSON.stringify({
          ...msg,
          recognizedAt: new Date().toISOString(),
          provider: this.provider.getName(),
        }),
      };

      // Save to database
      try {
        saveMessage(messageRecord);
        this.status.messagesCollected++;
        logger.info(`[${result.roomName}] ${msg.sender}: ${msg.content.substring(0, 50)}`);
      } catch (error) {
        logger.error('Failed to save message:', error);
      }

      // Queue webhook
      if (config.webhook.enabled) {
        webhookQueue.enqueue({
          messageId: messageRecord.messageId,
          roomId: messageRecord.roomId,
          roomName: messageRecord.roomName,
          talkerId: messageRecord.talkerId,
          talkerName: messageRecord.talkerName,
          content: messageRecord.content,
          messageType: messageRecord.messageType,
          timestamp: messageRecord.timestamp,
        });
      }
    }
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    this.status.running = false;
    logger.info('Monitor stopped');
  }

  /**
   * Get current status
   */
  getStatus(): MonitorStatus {
    return { ...this.status };
  }

  /**
   * Get seen messages count
   */
  getSeenCount(): number {
    return this.seenMessages.size;
  }

  /**
   * Clear seen messages cache
   */
  clearCache(): void {
    this.seenMessages.clear();
    logger.info('Message cache cleared');
  }

  /**
   * Get seen messages map (for external access)
   */
  getSeenMessages(): Map<string, SeenMessage> {
    return this.seenMessages;
  }

  /**
   * Check if text mode is enabled
   */
  isTextMode(): boolean {
    return config.vision.extractMode === 'text';
  }
}

/**
 * Text mode message extractor
 * Uses "查找聊天内容" feature instead of VLM
 */
export async function extractMessagesTextMode(
  targetName: string,
  category: string,
  checkpoint?: string
): Promise<number> {
  if (config.vision.extractMode !== 'text') {
    logger.debug('[text mode] Text mode not enabled, skipping');
    return 0;
  }

  const monitor = getMonitor();
  const { extractChatHistory, ExtractedMessage } = require('../wechat');

  logger.info(`[text mode] Extracting messages for ${targetName} using chat history`);

  const messages = await extractChatHistory(targetName, category, 10);

  if (messages.length === 0) {
    logger.info('[text mode] No messages extracted');
    return 0;
  }

  // Process extracted messages
  let savedCount = 0;
  for (const msg of messages) {
    // In text mode, we only have content, no sender or time
    // Use current time as placeholder
    const timestamp = Date.now();
    const key = `${targetName}|${'未知'}|${msg.content.substring(0, 50)}`;

    // Check for duplicate
    const existing = monitor.getSeenMessages().get(key);
    if (existing) {
      continue;
    }

    // Save to database
    try {
      const messageRecord = {
        messageId: `text_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        roomId: targetName,
        roomName: targetName,
        talkerId: '未知',
        talkerName: '未知', // Text mode doesn't capture sender
        content: msg.content,
        messageType: 'text',
        timestamp,
        rawData: JSON.stringify({
          ...msg,
          recognizedAt: new Date().toISOString(),
          provider: 'text',
        }),
      };
      saveMessage(messageRecord);

      monitor.getSeenMessages().set(key, {
        roomName: targetName,
        sender: '未知',
        content: msg.content,
        timestamp,
      });

      savedCount++;
    } catch (err) {
      logger.warn('[text mode] Failed to save message:', err);
    }
  }

  logger.info(`[text mode] Saved ${savedCount} new messages`);
  return savedCount;
}

// Singleton instance
let monitor: MessageMonitor | null = null;

export function getMonitor(): MessageMonitor {
  if (!monitor) {
    monitor = new MessageMonitor();
  }
  return monitor;
}
