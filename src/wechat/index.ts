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
