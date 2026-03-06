/**
 * V2 Processor: Sharp Segmentation + OCR + VLM
 *
 * Flow:
 * 1. Sharp segment screenshot into message blocks
 * 2. For each block:
 *    - text: double-click + Ctrl+C to copy -> save to memory
 *    - image: AHK right-click save as -> save to disk with hash filename
 *    - file: AHK right-click save as -> save to disk with hash filename
 *    - video: AHK right-click save as -> save to disk with hash filename
 */
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import {
  processScreenshot,
  MessageBlock,
  imageToBase64,
  cropBlock,
} from './sharpProcessor.js';
import { createVisionProvider } from './providers.js';
import { saveAttachmentFull, copyMessageText } from '../wechat/ahkBridge.js';

export interface V2Message {
  sender: string;
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

const textMessageStore: V2Message[] = [];
const ATTACHMENT_DIR = path.join(process.cwd(), 'data', 'attachments');

function ensureAttachmentDir(): void {
  if (!fs.existsSync(ATTACHMENT_DIR)) {
    fs.mkdirSync(ATTACHMENT_DIR, { recursive: true });
  }
}

function generateHash(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex').slice(0, 12);
}

export async function processScreenshotV2(
  screenshotPath: string,
  targetName: string,
  windowRect: { x: number; y: number; width: number; height: number }
): Promise<V2ProcessResult> {
  logger.info('[V2Processor] Processing: ' + screenshotPath);

  const { blocks } = await processScreenshot(screenshotPath);
  logger.info('[V2Processor] Found ' + blocks.length + ' message blocks');

  const messages: V2Message[] = [];

  const vision = createVisionProvider();
  if (!vision || vision.constructor.name === 'DisabledProvider') {
    logger.warn('[V2Processor] No vision provider available, skipping VLM');
  }

  if (vision) {
    try {
      const tempPaths: string[] = [];

      for (const block of blocks) {
        const tempPath = path.join(
          process.cwd(),
          'data',
          'screenshots',
          'vlm',
          'block_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.jpg'
        );
        await cropBlock(screenshotPath, block, tempPath);
        tempPaths.push(tempPath);
      }

      const buffers = tempPaths.map(p => fs.readFileSync(p));

      const result = await vision.recognize(buffers, {
        targetName,
        category: '',
        promptMode: 'v2',
      });

      for (const tempPath of tempPaths) {
        try { fs.unlinkSync(tempPath); } catch (e) { /* ignore */ }
      }

      if (result.messages && result.messages.length > 0) {
        for (let i = 0; i < Math.min(result.messages.length, blocks.length); i++) {
          const vlmMsg = result.messages[i];
          const block = blocks[i];

          let type: V2Message['type'] = 'text';
          let content = vlmMsg.content || '';

          if (block.type === 'image') {
            type = 'image';
            content = '【图片】' + content;
          } else if (block.type === 'video') {
            type = 'video';
            content = '【视频】' + content;
          } else if (block.type === 'file') {
            type = 'file';
            content = '【文件】';
          }

          messages.push({
            sender: vlmMsg.sender || '',
            content,
            time: vlmMsg.time || undefined,
            type,
            bounds: { x: block.x, y: block.y, w: block.w, h: block.h },
          });
        }
      }

      logger.info('[V2Processor] VLM recognized ' + messages.length + ' messages');
    } catch (error) {
      logger.error('[V2Processor] VLM recognition failed:', error);
    }
  }

  ensureAttachmentDir();

  for (const block of blocks) {
    try {
      const clickX = windowRect.x + block.x + Math.round(block.w / 2);
      const clickY = windowRect.y + block.y + Math.round(block.h / 2);

      if (block.type === 'image' || block.type === 'video' || block.type === 'file') {
        const hash = generateHash(targetName + '_' + block.x + '_' + block.y + '_' + Date.now());
        const ext = block.type === 'image' ? 'jpg' : block.type === 'video' ? 'mp4' : 'dat';
        const filename = hash + '.' + ext;

        logger.info('[V2Processor] Saving ' + block.type + ' at (' + clickX + ', ' + clickY + '), filename: ' + filename);

        const result = await saveAttachmentFull(clickX, clickY, filename);

        if (result.success) {
          const savedPath = path.join(ATTACHMENT_DIR, filename);
          logger.info('[V2Processor] ' + block.type + ' saved: ' + savedPath);

          const msg = messages.find(m => m.bounds.x === block.x && m.bounds.y === block.y);
          if (msg) {
            msg.filePath = savedPath;
          }
        } else {
          logger.error('[V2Processor] Failed to save ' + block.type + ': ' + result.message);
        }
      } else if (block.type === 'text') {
        logger.info('[V2Processor] Copying text at (' + clickX + ', ' + clickY + ')');

        const result = await copyMessageText(clickX, clickY);

        if (result.success) {
          logger.info('[V2Processor] Text copied from block at (' + block.x + ', ' + block.y + ')');

          const msg = messages.find(m => m.bounds.x === block.x && m.bounds.y === block.y);
          if (msg) {
            textMessageStore.push(msg);
            logger.info('[V2Processor] Text message stored in memory (total: ' + textMessageStore.length + ')');
          }
        } else {
          logger.error('[V2Processor] Failed to copy text: ' + result.message);
        }
      }
    } catch (error) {
      logger.error('[V2Processor] Error processing block type ' + block.type + ':', error);
    }
  }

  return { messages, screenshotPath };
}

export function getStoredTextMessages(): V2Message[] {
  return [...textMessageStore];
}

export function clearStoredTextMessages(): void {
  textMessageStore.length = 0;
}

export async function detectBlockTypes(screenshotPath: string): Promise<MessageBlock[]> {
  const { blocks } = await processScreenshot(screenshotPath);
  return blocks;
}

export function findAttachmentIcons(
  screenshotPath: string,
  iconType: 'image' | 'file' | 'voice' | 'video'
): Array<{ x: number; y: number; w: number; h: number; score: number }> {
  logger.warn('[V2Processor] Template matching not implemented with Sharp');
  return [];
}
