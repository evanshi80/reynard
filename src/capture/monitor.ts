import { config } from '../config';
import { RecognizedMessage } from '../types';
import { createVisionProvider } from '../vision/providers';
import { saveMessage } from '../database/repositories/messageRepository';
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

    for (const msg of result.messages) {
      const key = this.getMessageKey(result.roomName, msg.sender, msg.content);

      if (this.isDuplicate(key)) {
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
      // Try to parse time from LLM response, otherwise use current time
      let timestamp = Date.now();
      if (msg.time) {
        // Format examples: "09:30" (today), "1/15 09:30" (past date), "1月15日 09:30" (Chinese format)
        const now = new Date();
        const capturedTime = this.status.lastCapture ? new Date(this.status.lastCapture) : now;

        // Try parsing date+time format (M/d HH:mm or M月d日 HH:mm)
        const dateTimeMatch = msg.time.match(/(\d{1,2})[\/\月](\d{1,2})[\日]?\s*(\d{1,2}):(\d{2})/);
        if (dateTimeMatch) {
          const month = parseInt(dateTimeMatch[1], 10);
          const day = parseInt(dateTimeMatch[2], 10);
          const hours = parseInt(dateTimeMatch[3], 10);
          const minutes = parseInt(dateTimeMatch[4], 10);
          timestamp = new Date(now.getFullYear(), month - 1, day, hours, minutes, 0, 0).getTime();
        } else {
          // Try simple time format (HH:mm)
          const timeMatch = msg.time.match(/(\d{1,2}):(\d{2})/);
          if (timeMatch) {
            const hours = parseInt(timeMatch[1], 10);
            const minutes = parseInt(timeMatch[2], 10);
            timestamp = new Date(capturedTime.setHours(hours, minutes, 0, 0)).getTime();
          }
        }
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
}

// Singleton instance
let monitor: MessageMonitor | null = null;

export function getMonitor(): MessageMonitor {
  if (!monitor) {
    monitor = new MessageMonitor();
  }
  return monitor;
}
