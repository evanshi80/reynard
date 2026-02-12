/**
 * Test script for Bot Starter
 */
import { config } from './src/config';
import { initializeBot } from './src/bot/starter';

async function main() {
  console.log('=== Bot Starter Test ===\n');

  console.log('Bot config:');
  console.log(`  enabled: ${config.bot.enabled}`);
  console.log(`  targets: ${JSON.stringify(config.bot.targets)}`);
  console.log(`  greeting: "${config.bot.greetingMessage}"`);
  console.log(`  delay: ${config.bot.delayBetweenTargets}ms\n`);

  if (!config.bot.enabled) {
    console.log('BOT_ENABLED is false, skipping bot initialization');
    return;
  }

  if (config.bot.targets.length === 0) {
    console.log('No targets configured, skipping bot initialization');
    return;
  }

  console.log('Initializing bot...');
  const result = await initializeBot();
  console.log(`Bot initialization result: ${result}`);
}

main().catch(console.error);
