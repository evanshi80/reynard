import * as ahk from './ahkBridge';
import { findCategoryPosition, terminateOcr } from './ocr';
import { isAhkAvailable } from './ahkBridge';
import { WindowFinder } from '../capture/windowFinder';
import logger from '../utils/logger';

export { isAhkAvailable, terminateOcr };

const windowFinder = new WindowFinder();

/**
 * Activate WeChat window
 */
export async function activateWeChat(): Promise<boolean> {
  try {
    const result = await ahk.activateWeChat();
    return result.success;
  } catch (error) {
    logger.error('Failed to activate WeChat:', error);
    return false;
  }
}

import { config } from '../config';

// ... existing code ...

/**
 * Open a chat by navigating to a category and selecting the first result
 */
export async function openChat(contactName: string, category: string = '联系人'): Promise<boolean> {
  try {
    // 1. First, type the search to populate results
    await ahk.typeSearch(contactName);
    await new Promise(r => setTimeout(r, config.ocr.searchLoadWait));  // Wait for results to load

    // 2. Retry finding window (it might not be visible immediately)
    let win = null;
    for (let i = 0; i < 3; i++) {
      win = windowFinder.findWeChatWindow();
      if (win) break;
      await new Promise(r => setTimeout(r, 500));
    }

    if (!win) {
      logger.error('WeChat window not found');
      return false;
    }

    // Use the DPI from the found window
    windowFinder.setWindowHandle(win.handle);
    const dpi = windowFinder.getDpiScaleForLastWindow();

    // 3. Capture search results area
    const sidebarW = Math.min(Math.round(win.width * 0.35), 400);
    const result = await findCategoryPosition(
      category,
      win.x,
      win.y + 50,
      sidebarW,
      Math.min(win.height - 50, 600),
      dpi
    );

    if (!result) {
      logger.warn('Could not find category, falling back to default');
      return (await ahk.openFirstResult(contactName)).success;
    }

    logger.info(`Navigating to "${contactName}" via ${category}: Home + ${result.downCount} Down`);
    const ahkResult = await ahk.navigateToResult(contactName, result.downCount);
    return ahkResult.success;
  } catch (error) {
    logger.error(`Failed to open chat "${contactName}":`, error);
    return false;
  }
}

/**
 * Send a message to the currently active chat
 */
export async function sendMessage(message: string): Promise<boolean> {
  try {
    const result = await ahk.sendMessage(message);
    return result.success;
  } catch (error) {
    logger.error('Failed to send message:', error);
    return false;
  }
}

/**
 * Send a message to a specific contact/group
 */
export async function sendToContact(contact: string, message: string, category: string = '联系人'): Promise<boolean> {
  try {
    const opened = await openChat(contact, category);
    if (!opened) return false;

    await new Promise(resolve => setTimeout(resolve, 300));
    const result = await ahk.sendMessage(message);
    return result.success;
  } catch (error) {
    logger.error(`Failed to send to "${contact}":`, error);
    return false;
  }
}

// ============================================================
// Chat History Extraction (Text Mode)
// ============================================================

export interface ExtractedMessage {
  content: string;
  sender?: string;
  time?: string;
}

/**
 * Extract chat messages using "查找聊天内容" feature
 * This is an alternative to VLM-based extraction
 *
 * @param targetName - Chat name (group or contact)
 * @param category - Chat category ('群聊' or '联系人')
 * @param maxScrolls - Maximum number of scrolls to go back
 * @returns Array of extracted messages (content only, no sender/time in text mode)
 */
export async function extractChatHistory(
  targetName: string,
  category: string,
  maxScrolls: number = 10
): Promise<ExtractedMessage[]> {
  const messages: ExtractedMessage[] = [];

  try {
    // 1. Open the chat
    logger.info(`[extractChatHistory] Opening chat: ${targetName}`);
    const opened = await openChat(targetName, category);
    if (!opened) {
      logger.error(`[extractChatHistory] Failed to open chat: ${targetName}`);
      return messages;
    }

    await new Promise(r => setTimeout(r, 500));

    // 2. Find window coordinates
    const win = windowFinder.findWeChatWindow();
    if (!win) {
      logger.error('[extractChatHistory] WeChat window not found');
      return messages;
    }

    const winX = win.x;
    const winY = win.y;
    const winW = win.width;
    const winH = win.height;

    // 3. Click three dots to open menu
    logger.info('[extractChatHistory] Clicking three dots menu');
    const menuResult = await ahk.clickThreeDots(winX, winY, winW, winH);
    if (!menuResult.success) {
      logger.error('[extractChatHistory] Failed to click three dots');
      return messages;
    }

    await new Promise(r => setTimeout(r, 300));

    // 4. Select "查找聊天内容"
    logger.info('[extractChatHistory] Selecting 查找聊天内容');
    const selectResult = await ahk.selectMenuItem('查找聊天内容');
    if (!selectResult.success) {
      logger.error('[extractChatHistory] Failed to select menu item');
      return messages;
    }

    // Wait for chat history window to load
    await new Promise(r => setTimeout(r, 1000));

    // 5. Re-find window coordinates (popup may have different position/size)
    const popupWin = windowFinder.findWeChatWindow();
    let popupX = winX, popupY = winY, popupW = winW, popupH = winH;
    if (popupWin) {
      popupX = popupWin.x;
      popupY = popupWin.y;
      popupW = popupWin.width;
      popupH = popupWin.height;
      logger.info(`[extractChatHistory] Popup window: ${popupW}x${popupH} at (${popupX}, ${popupY})`);
    }

    // 6. Scroll and copy messages
    for (let i = 0; i < maxScrolls; i++) {
      // Copy current message (use popup coordinates)
      const copyResult = await ahk.copyMessage(popupX, popupY, popupW, popupH);
      if (copyResult.success) {
        await new Promise(r => setTimeout(r, 200));

        // Read clipboard
        const clipResult = await ahk.readClipboard();
        if (clipResult.success && clipResult.message) {
          const content = clipResult.message.trim();
          logger.debug(`[extractChatHistory] Clipboard content: ${content.substring(0, 100)}...`);
          if (content && content.length > 0) {
            messages.push({ content });
          }
        } else {
          logger.warn(`[extractChatHistory] Clipboard read failed or empty`);
        }
      } else {
        logger.warn(`[extractChatHistory] Copy message failed`);
      }

      // Scroll up to load more
      await ahk.scrollHistory();
      await new Promise(r => setTimeout(r, 500));
    }

    logger.info(`[extractChatHistory] Extracted ${messages.length} messages`);
  } catch (error) {
    logger.error('[extractChatHistory] Error:', error);
  }

  return messages;
}
