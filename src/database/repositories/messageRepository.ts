import { getDatabase } from '../client';
import { MessageRecord } from '../../types';
import logger from '../../utils/logger';

/**
 * Save a message to the database
 */
export function saveMessage(message: MessageRecord): number | bigint {
  const db = getDatabase();

  try {
    const stmt = db.prepare(`
      INSERT INTO messages (
        message_id, room_id, room_name, talker_id, talker_name,
        content, message_type, timestamp, msg_index, raw_data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      message.messageId,
      message.roomId,
      message.roomName,
      message.talkerId,
      message.talkerName,
      message.content,
      message.messageType,
      message.timestamp,
      message.msgIndex || 0,
      message.rawData
    );

    logger.debug(`Message saved: ${message.messageId} from ${message.talkerName} in ${message.roomName}`);
    return result.lastInsertRowid;
  } catch (error: any) {
    // Ignore duplicate message errors
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      logger.debug(`Duplicate message ignored: ${message.messageId}`);
      return 0;
    }

    logger.error(`Failed to save message: ${message.messageId}`, error);
    throw error;
  }
}

/**
 * Check if a message with similar content already exists in the room
 * Uses content hash to detect duplicates
 */
export function messageExistsInRoom(roomName: string, content: string, maxTimeDiff: number = 60000): boolean {
  const db = getDatabase();
  const now = Date.now();
  const startTime = now - maxTimeDiff;

  // Normalize content for comparison
  const contentNorm = content.replace(/\s+/g, '').toLowerCase();

  // Get recent messages from this room
  const stmt = db.prepare(`
    SELECT content FROM messages
    WHERE room_name = ? AND timestamp > ?
  `);

  const recentMessages = stmt.all(roomName, startTime) as { content: string }[];

  for (const msg of recentMessages) {
    const msgNorm = msg.content.replace(/\s+/g, '').toLowerCase();
    if (msgNorm === contentNorm) {
      return true;
    }
  }

  return false;
}

/**
 * Get messages by room ID
 */
export function getMessagesByRoom(roomId: string, limit: number = 100, offset: number = 0): MessageRecord[] {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM messages
    WHERE room_id = ?
    ORDER BY timestamp DESC, msg_index ASC
    LIMIT ? OFFSET ?
  `);

  return stmt.all(roomId, limit, offset) as MessageRecord[];
}

/**
 * Get messages by time range
 */
export function getMessagesByTimeRange(startTime: number, endTime: number, limit: number = 1000): MessageRecord[] {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM messages
    WHERE timestamp BETWEEN ? AND ?
    ORDER BY timestamp DESC, msg_index ASC
    LIMIT ?
  `);

  return stmt.all(startTime, endTime, limit) as MessageRecord[];
}

/**
 * Get total message count
 */
export function getTotalMessageCount(): number {
  const db = getDatabase();
  const result = db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };
  return result.count;
}

/**
 * Get message count by room
 */
export function getMessageCountByRoom(roomId: string): number {
  const db = getDatabase();
  const result = db.prepare('SELECT COUNT(*) as count FROM messages WHERE room_id = ?').get(roomId) as { count: number };
  return result.count;
}

/**
 * Delete old messages (cleanup)
 */
export function deleteOldMessages(beforeTimestamp: number): number {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM messages WHERE timestamp < ?');
  const result = stmt.run(beforeTimestamp);
  logger.info(`Deleted ${result.changes} old messages before timestamp ${beforeTimestamp}`);
  return result.changes;
}
