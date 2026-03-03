/**
 * V2 Processor: OpenCV Segmentation + OCR + VLM
 *
 * Flow:
 * 1. OpenCV segment screenshot into message blocks
 * 2. For each block:
 *    - text: Tesseract OCR → save to DB
 *    - image: AHK right-click save → VLM describe → save
 *    - file: AHK right-click save → save marker
 */
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import { logger } from '../utils/logger.js';
import {
  processScreenshot,
  MessageBlock,
  matToBase64,
  loadImage,
  saveImage,
} from './opencvProcessor.js';
import { templateManager } from './templateManager.js';
import { getVisionProvider } from './providers.js';
import { recognizeText } from '../wechat/ocr.js';
import { saveAttachment } from '../wechat/index.js';
import { WindowRect } from '../types/index.js';

export interface V2Message {
  sender: string;
  content: string;
  time?: string;
  type: 'text' | 'image' | 'file' | 'mixed';
  bounds: { x: number; y: number; w: number; h: number };
  attachmentPath?: string;
}

export interface V2ProcessResult {
  messages: V2Message[];
  screenshotPath: string;
}

/**
 * Process a single screenshot using V2 pipeline
 */
export async function processScreenshotV2(
  screenshotPath: string,
  targetName: string,
  windowRect: WindowRect
): Promise<V2ProcessResult> {
  logger.info(`[V2Processor] Processing: ${screenshotPath}`);

  // Initialize template manager
  await templateManager.initialize();

  // Use OpenCV to segment message blocks
  const { blocks, image } = processScreenshot(screenshotPath);
  logger.info(`[V2Processor] Found ${blocks.length} message blocks`);

  const messages: V2Message[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    logger.debug(`[V2Processor] Block ${i}: type=${block.type}, y=${block.y}, h=${block.h}`);

    try {
      if (block.type === 'text' || block.type === 'image' || block.type === 'file') {
        // For now, we'll use the existing VLM to get structured message data
        // OpenCV gives us the blocks, VLM extracts the content
        const msg = await processBlockWithVLM(screenshotPath, block, windowRect);
        if (msg) {
          messages.push(msg);
        }
      }
    } catch (error) {
      logger.error(`[V2Processor] Error processing block ${i}:`, error);
    }
  }

  // Cleanup
  image.delete();

  return {
    messages,
    screenshotPath,
  };
}

/**
 * Process a single block using VLM to extract structured data
 * Uses the block bounds from OpenCV for more accurate parsing
 */
async function processBlockWithVLM(
  screenshotPath: string,
  block: MessageBlock,
  windowRect: WindowRect
): Promise<V2Message | null> {
  const vision = getVisionProvider();
  if (!vision || vision.constructor.name === 'DisabledProvider') {
    logger.warn('[V2Processor] No vision provider, skipping VLM');
    return null;
  }

  try {
    // Crop the block region
    const img = loadImage(screenshotPath);
    const blockImg = img.getRegion(
      {
        x: Math.max(0, block.x),
        y: Math.max(0, block.y),
        width: block.w,
        height: block.h,
      }
    );

    // Save block as temp image
    const tempPath = path.join(
      process.cwd(),
      'data',
      'screenshots',
      'vlm',
      `block_${Date.now()}.jpg`
    );
    saveImage(blockImg, tempPath);
    img.delete();
    blockImg.delete();

    // Read as base64
    const base64 = fs.readFileSync(tempPath, { encoding: 'base64' });

    // Use VLM to analyze this specific block
    const prompt = `Analyze this message bubble from a WeChat chat. Return JSON with:
{
  "sender": "sender name or empty",
  "content": "message text content",
  "time": "timestamp if visible or empty",
  "type": "text|image|file",
  "hasAttachment": true|false,
  "attachmentDescription": "description if image, or filename if file"
}`;

    const result = await vision.analyzeImage(
      `data:image/jpeg;base64,${base64}`,
      prompt
    );

    // Parse VLM response
    const parsed = parseVlmResponse(result);
    if (!parsed) {
      logger.warn('[V2Processor] Failed to parse VLM response');
      return null;
    }

    // Determine type from OpenCV detection + VLM
    let type: V2Message['type'] = 'text';
    if (block.type === 'image' || parsed.hasAttachment) {
      type = 'image';
    } else if (block.type === 'file') {
      type = 'file';
    }

    // If image with attachment, try to save it
    let attachmentPath: string | undefined;
    if (type === 'image' && parsed.hasAttachment) {
      try {
        // Calculate click position: window position + block position
        const clickX = windowRect.x + block.x + Math.round(block.w * 0.1);
        const clickY = windowRect.y + block.y + Math.round(block.h * 0.5);

        logger.info(`[V2Processor] Saving attachment at (${clickX}, ${clickY})`);

        const saveResult = await saveAttachment(clickX, clickY);
        if (saveResult.success && saveResult.path) {
          attachmentPath = saveResult.path;
          // Update content with attachment marker
          parsed.content += `【图片：${parsed.attachmentDescription || '图片'}】`;
        }
      } catch (error) {
        logger.error('[V2Processor] Failed to save attachment:', error);
      }
    }

    // Clean up temp file
    try {
      fs.unlinkSync(tempPath);
    } catch (e) {
      // ignore
    }

    return {
      sender: parsed.sender || 'Unknown',
      content: parsed.content,
      time: parsed.time,
      type,
      bounds: { x: block.x, y: block.y, w: block.w, h: block.h },
      attachmentPath,
    };
  } catch (error) {
    logger.error('[V2Processor] VLM block analysis failed:', error);
    return null;
  }
}

/**
 * Parse VLM JSON response with fallback
 */
function parseVlmResponse(response: string): {
  sender: string;
  content: string;
  time: string;
  type: string;
  hasAttachment: boolean;
  attachmentDescription: string;
} | null {
  try {
    // Try direct parse
    const parsed = JSON.parse(response);
    return parsed;
  } catch (e) {
    // Try extract JSON from markdown
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (e2) {
        logger.warn('[V2Processor] Failed to parse VLM JSON:', jsonMatch[0]);
      }
    }
  }
  return null;
}

/**
 * Quick block type detection using OpenCV only
 * Faster than full VLM analysis, useful for filtering
 */
export function detectBlockTypes(screenshotPath: string): MessageBlock[] {
  const { blocks } = processScreenshot(screenshotPath);
  return blocks;
}

/**
 * Find attachment icons using template matching
 */
export function findAttachmentIcons(
  screenshotPath: string,
  iconType: 'image' | 'file' | 'voice' | 'video'
): Array<{ x: number; y: number; w: number; h: number; score: number }> {
  const { matchTemplate, loadImage } = require('./opencvProcessor.js');
  const template = templateManager.getTemplate(iconType);

  if (!template) {
    logger.warn(`[V2Processor] Template not found: ${iconType}`);
    return [];
  }

  const img = loadImage(screenshotPath);
  const matches: Array<{ x: number; y: number; w: number; h: number; score: number }> = [];

  let searchImg = img;
  for (let i = 0; i < 10; i++) {
    const result = matchTemplate(searchImg, template, 0.7);
    if (result) {
      matches.push(result);
      // Mask out this area for next search
      const maskRegion = {
        x: Math.max(0, result.x - 20),
        y: Math.max(0, result.y - 20),
        width: Math.min(result.w + 40, searchImg.cols - result.x),
        height: Math.min(result.h + 40, searchImg.rows - result.y),
      };
      searchImg
        .getRegion(maskRegion)
        .setTo(0);
    } else {
      break;
    }
  }

  img.delete();
  return matches;
}
