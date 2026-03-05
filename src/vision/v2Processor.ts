/**
 * V2 Processor: Sharp Segmentation + OCR + VLM
 *
 * Flow:
 * 1. Sharp segment screenshot into message blocks
 * 2. For each block:
 *    - text: VLM recognize → save to DB
 *    - image: AHK right-click save → mark as 【图片】
 *    - file: AHK right-click save → mark as 【文件】
 */
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger.js';
import {
  processScreenshot,
  MessageBlock,
  imageToBase64,
  cropBlock,
} from './sharpProcessor.js';
import { createVisionProvider } from './providers.js';
import { saveAttachment } from '../wechat/ahkBridge.js';

export interface V2Message {
  sender: string;
  content: string;
  time?: string;
  type: 'text' | 'image' | 'file' | 'video' | 'mixed';
  bounds: { x: number; y: number; w: number; h: number };
}

export interface V2ProcessResult {
  messages: V2Message[];
  screenshotPath: string;
}

/**
 * Process a single screenshot using V2 pipeline (Sharp + VLM)
 */
export async function processScreenshotV2(
  screenshotPath: string,
  targetName: string,
  windowRect: { x: number; y: number; width: number; height: number }
): Promise<V2ProcessResult> {
  logger.info(`[V2Processor] Processing: ${screenshotPath}`);

  // Use Sharp to segment message blocks
  const { blocks } = await processScreenshot(screenshotPath);
  logger.info(`[V2Processor] Found ${blocks.length} message blocks`);

  const messages: V2Message[] = [];

  // Get vision provider
  const vision = createVisionProvider();
  if (!vision || vision.constructor.name === 'DisabledProvider') {
    logger.warn('[V2Processor] No vision provider available');
  }

  // For now, batch process all blocks with VLM
  // Later we can optimize to process only certain types
  if (vision) {
    try {
      // Crop all blocks and prepare for VLM
      const tempPaths: string[] = [];
      const blockMap: MessageBlock[] = [];

      for (const block of blocks) {
        const tempPath = path.join(
          process.cwd(),
          'data',
          'screenshots',
          'vlm',
          `block_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`
        );
        await cropBlock(screenshotPath, block, tempPath);
        tempPaths.push(tempPath);
        blockMap.push(block);
      }

      // Read all images as buffers
      const buffers = tempPaths.map(p => fs.readFileSync(p));

      // Call VLM to recognize all blocks at once
      const result = await vision.recognize(buffers, {
        targetName,
        category: '',
        promptMode: 'v2',
      });

      // Clean up temp files
      for (const tempPath of tempPaths) {
        try { fs.unlinkSync(tempPath); } catch (e) { /* ignore */ }
      }

      // Process VLM results
      if (result.messages && result.messages.length > 0) {
        // Map VLM results back to blocks
        for (let i = 0; i < Math.min(result.messages.length, blocks.length); i++) {
          const vlmMsg = result.messages[i];
          const block = blocks[i];

          // Override type based on Sharp detection
          let type: V2Message['type'] = 'text';
          let content = vlmMsg.content || '';

          // Add marker based on Sharp detection
          if (block.type === 'image') {
            type = 'image';
            content = `【图片】${content}`.trim();
          } else if (block.type === 'video') {
            type = 'video';
            content = `【视频】${content}`.trim();
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

      logger.info(`[V2Processor] VLM recognized ${messages.length} messages`);
    } catch (error) {
      logger.error('[V2Processor] VLM recognition failed:', error);
    }
  }

  // Save attachments for image/video/file blocks
  for (const block of blocks) {
    if (block.type === 'image' || block.type === 'video' || block.type === 'file') {
      try {
        // Calculate click position
        const clickX = windowRect.x + block.x + Math.round(block.w * (block.type === 'file' ? 0.8 : 0.1));
        const clickY = windowRect.y + block.y + Math.round(block.h * 0.5);

        logger.info(`[V2Processor] Saving ${block.type} at (${clickX}, ${clickY})`);

        await saveAttachment(clickX, clickY);
      } catch (error) {
        logger.error(`[V2Processor] Failed to save ${block.type}:`, error);
      }
    }
  }

  return { messages, screenshotPath };
}

/**
 * Quick block type detection using Sharp only
 * Faster than full VLM analysis, useful for filtering
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
  // Template matching with Sharp is more complex
  // For now, return empty array
  logger.warn('[V2Processor] Template matching not implemented with Sharp');
  return [];
}
