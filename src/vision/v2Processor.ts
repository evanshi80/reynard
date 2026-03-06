/**
 * V2 Processor: Sharp Segmentation + AHK Actions
 *
 * Flow:
 * 1. Sharp segment screenshot into message blocks
 * 2. For each block:
 *    - text: double-click + Ctrl+C to copy -> print to log
 *    - image: AHK right-click save as -> save to disk with hash filename
 *    - file: AHK right-click save as -> save to disk with hash filename
 *    - video: AHK right-click save as -> save to disk with hash filename
 *
 * NOTE: This is independent of VLM Cycle. No VLM calls here.
 */
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import {
  processScreenshot,
  MessageBlock,
} from './sharpProcessor.js';
import { saveAttachmentFull, copyMessageText, activateWeChat } from '../wechat/ahkBridge.js';

export interface V2Message {
  sender?: string;
  content: string;
  time?: string;
  type: 'text' | 'image' | 'file' | 'video' | 'mixed';
  bounds: { x: number; y: number; w: number; h: number };
  filePath?: string;
}

export interface V2ProcessResult {
  messages: V2Message[];
  screenshotPath: string;
}

// In-memory store for copied text messages (for verification)
const textMessageStore: V2Message[] = [];

// Download directory for attachments
const ATTACHMENT_DIR = path.join(process.cwd(), 'data', 'attachments');

function ensureAttachmentDir(): void {
  if (!fs.existsSync(ATTACHMENT_DIR)) {
    fs.mkdirSync(ATTACHMENT_DIR, { recursive: true });
  }
}

function generateHash(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex').slice(0, 12);
}

/**
 * Process a single screenshot using V2 pipeline (Sharp + AHK only, no VLM)
 *
 * This is the main entry point called from patrol:
 * 1. Segment screenshot into message blocks using Sharp
 * 2. For each block:
 *    - image/video/file: right-click -> save as to disk
 *    - text: double-click -> copy to clipboard -> log to console
 */
export async function processScreenshotV2(
  screenshotPath: string,
  targetName: string,
  windowRect: { x: number; y: number; width: number; height: number; chatOffsetX?: number; chatOffsetY?: number }
): Promise<V2ProcessResult> {
  logger.info('[V2] Processing: ' + screenshotPath);

  // Step 1: Sharp segment screenshot into message blocks
  const { blocks } = await processScreenshot(screenshotPath);
  logger.info('[V2] Found ' + blocks.length + ' message blocks');

  // Step 2: Process each block with AHK
  ensureAttachmentDir();

  const messages: V2Message[] = [];

  for (const block of blocks) {
      // Activate window before clicking
      await activateWeChat();
      await new Promise(r => setTimeout(r, 300));
    try {
      // Calculate absolute screen coordinates for click
      // Need chat area offset (sidebar width) to map screenshot coords to screen coords
      const chatStartX = windowRect.chatOffsetX || 0;
      // Y offset for header
      const chatStartY = windowRect.chatOffsetY || 0;
      const clickX = windowRect.x + chatStartX + block.x + Math.round(block.w / 2);
      const clickY = windowRect.y + chatStartY + block.y + Math.round(block.h / 2);

      if (block.type === 'image' || block.type === 'video' || block.type === 'file') {
        // Generate unique filename based on position + timestamp
        const hash = generateHash(targetName + '_' + block.x + '_' + block.y + '_' + Date.now());
        const ext = block.type === 'image' ? 'jpg' : block.type === 'video' ? 'mp4' : 'dat';
        const filename = hash + '.' + ext;

        logger.info('[V2] Saving ' + block.type + ' at (' + clickX + ', ' + clickY + '), file: ' + filename);

        // Execute full save-as workflow
        const result = await saveAttachmentFull(clickX, clickY, filename);

        if (result.success) {
          const savedPath = path.join(ATTACHMENT_DIR, filename);
          logger.info('[V2] ' + block.type + ' saved: ' + savedPath);

          messages.push({
            type: block.type,
            content: '【' + block.type + '】',
            bounds: { x: block.x, y: block.y, w: block.w, h: block.h },
            filePath: savedPath,
          });
        } else {
          logger.error('[V2] Failed to save ' + block.type + ': ' + result.message);
        }
      } else if (block.type === 'text') {
        // For text messages, double-click and copy to clipboard
        logger.info('[V2] Copying text at (' + clickX + ', ' + clickY + ')');

        const result = await copyMessageText(clickX, clickY);

        if (result.success) {
          logger.info('[V2] Text copied from block at (' + block.x + ', ' + block.y + ')');

          // Store for later retrieval
          const msg: V2Message = {
            type: 'text',
            content: '(copied to clipboard)',
            bounds: { x: block.x, y: block.y, w: block.w, h: block.h },
          };
          textMessageStore.push(msg);

          // Log the copied text (for POC verification)
          logger.info('[V2] ========== TEXT MESSAGE START ==========');
          logger.info('[V2] BLOCK: x=' + block.x + ', y=' + block.y + ', w=' + block.w + ', h=' + block.h);
          logger.info('[V2] TEXT: (copied to clipboard - check WeChat for content)');
          logger.info('[V2] ========== TEXT MESSAGE END ==========');

          messages.push(msg);
        } else {
          logger.error('[V2] Failed to copy text: ' + result.message);
        }
      }
    } catch (error) {
      logger.error('[V2] Error processing block type ' + block.type + ':', error);
    }
  }

  logger.info('[V2] Processed ' + messages.length + ' blocks');

  return { messages, screenshotPath };
}

/**
 * Get all stored text messages (from clipboard copy)
 */
export function getStoredTextMessages(): V2Message[] {
  return [...textMessageStore];
}

/**
 * Clear stored text messages
 */
export function clearStoredTextMessages(): void {
  textMessageStore.length = 0;
}

/**
 * Quick block type detection using Sharp only
 * Useful for filtering before full processing
 */
export async function detectBlockTypes(screenshotPath: string): Promise<MessageBlock[]> {
  const { blocks } = await processScreenshot(screenshotPath);
  return blocks;
}

/**
 * Find attachment icons using template matching (not implemented with Sharp)
 */
export function findAttachmentIcons(
  screenshotPath: string,
  iconType: 'image' | 'file' | 'voice' | 'video'
): Array<{ x: number; y: number; w: number; h: number; score: number }> {
  logger.warn('[V2] Template matching not implemented with Sharp');
  return [];
}
