/**
 * Bot Starter Module
 * Automatically activates WeChat and sends greeting messages to configured targets
 */
import { config } from '../config';
import logger from '../utils/logger';
import { activateWeChat, sendToContact, sendMessage } from '../wechat';

export interface BotTarget {
  name: string;
  category: string;
}

/**
 * Initialize bot: activate WeChat and send greetings to all configured targets
 */
export async function initializeBot(): Promise<boolean> {
  if (!config.bot.greetingEnabled) {
    logger.info('Bot greeting is disabled (BOT_GREETING_ENABLED=false)');
    return true;
  }

  const targets = config.bot.targets;
  if (targets.length === 0) {
    logger.info('No bot targets configured (BOT_TARGETS is empty)');
    return true;
  }

  logger.info('======================================');
  logger.info('       Bot Initializing...            ');
  logger.info('======================================');
  logger.info(`Targets: ${targets.length}`);

  try {
    // 1. Activate WeChat window
    logger.info('Activating WeChat...');
    const activated = await activateWeChat();

    if (!activated) {
      logger.warn('Failed to activate WeChat window, trying anyway...');
    } else {
      logger.info('WeChat activated');
    }

    // Wait for window to be ready
    await new Promise(r => setTimeout(r, 500));

    // 2. Send greeting to each target
    const greeting = config.bot.greetingMessage;
    logger.info(`Greeting message: "${greeting}"`);

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      logger.info(`[${i + 1}/${targets.length}] Opening "${target.name}" (${target.category})...`);

      try {
        const opened = await sendToContact(target.name, greeting, target.category);

        if (opened) {
          logger.info(`  ✓ Sent greeting to "${target.name}"`);
          successCount++;
        } else {
          logger.warn(`  ✗ Failed to open "${target.name}"`);
          failCount++;
        }
      } catch (error) {
        logger.error(`  ✗ Error sending to "${target.name}":`, error);
        failCount++;
      }

      // Wait between targets (except after the last one)
      if (i < targets.length - 1) {
        const delay = config.bot.delayBetweenTargets;
        logger.debug(`Waiting ${delay}ms before next target...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    logger.info('======================================');
    logger.info(`Bot initialized: ${successCount} success, ${failCount} failed`);
    logger.info('======================================');

    return failCount === 0;
  } catch (error) {
    logger.error('Bot initialization failed:', error);
    return false;
  }
}

/**
 * Send a message to a specific target
 */
export async function sendToTarget(targetName: string, message: string, category: string = '联系人'): Promise<boolean> {
  // Activate WeChat first
  await activateWeChat();
  await new Promise(r => setTimeout(r, 300));

  return await sendToContact(targetName, message, category);
}
