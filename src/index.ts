import { config } from './config';
import logger from './utils/logger';
import { initDatabase, closeDatabase } from './database/client';
import { startWebServer, stopWebServer } from './web/server';
import { createVisionProvider } from './vision/providers';
import { getVlmCycle } from './vision/vlmCycle';
import { webhookQueue } from './webhook/queue';
import { startPatrol, stopPatrol } from './bot/patrol';

/**
 * Main application entry point
 * Reynard - Windows WeChat Monitor with Vision-based Message Collection
 */
async function main() {
  try {
    logger.info('======================================');
    logger.info('       Reynard Monitor Starting...    ');
    logger.info('======================================');
    logger.info(`Provider: ${config.vision.provider}`);
    logger.info(`Capture Window: ${config.capture.windowName}`);

    // Initialize database
    logger.info('Initializing database...');
    initDatabase();
    logger.info('Database initialized');

    // Start web server
    if (config.web.enabled) {
      logger.info('Starting web server...');
      await startWebServer();
    }

    // Check vision provider
    const provider = createVisionProvider();
    const available = await provider.isAvailable();

    if (!available) {
      logger.error(`Vision provider "${provider.getName()}" is not available`);
      logger.error('Please check your configuration:');
      logger.error('');
      if (config.vision.provider === 'ollama') {
        logger.error('  - Make sure Ollama is running');
        logger.error('  - Install model: ollama pull llava');
        logger.error('  - Set VISION_MODEL=llava in .env');
      } else if (config.vision.provider === 'openai') {
        logger.error('  - Set VISION_API_KEY or OPENAI_API_KEY in .env');
      } else if (config.vision.provider === 'anthropic') {
        logger.error('  - Set VISION_API_KEY or ANTHROPIC_API_KEY in .env');
      }
      logger.error('');
      logger.error('Starting anyway - VLM cycle will fail until provider is configured');
    } else {
      logger.info(`Vision provider ready: ${provider.getName()}`);
    }

    // Start patrol (screenshots only, no VLM calls)
    logger.info('Starting patrol...');
    await startPatrol();

    // Start VLM analysis cycle (stitches patrol screenshots → VLM → DB)
    const vlmCycle = getVlmCycle();
    vlmCycle.start();

    logger.info('======================================');
    logger.info('   Reynard Monitor started successfully');
    logger.info('======================================');
    logger.info(`Web UI: http://localhost:${config.web.port}/monitor`);
    logger.info(`VLM cycle interval: ${config.vlm.cycleInterval}ms`);
    logger.info('Press Ctrl+C to stop');
  } catch (error) {
    logger.error('Failed to start application', error);
    process.exit(1);
  }
}

/**
 * Graceful shutdown handler
 */
async function shutdown(signal: string) {
  logger.info(`\nReceived ${signal}, shutting down gracefully...`);

  try {
    // Stop patrol
    logger.info('Stopping patrol...');
    stopPatrol();

    // Stop VLM cycle
    logger.info('Stopping VLM cycle...');
    try {
      const vlmCycle = getVlmCycle();
      vlmCycle.stop();
    } catch {
      // VLM cycle might not be started
    }

    // Flush webhook queue
    logger.info('Flushing webhook queue...');
    await webhookQueue.flush();

    // Stop web server
    logger.info('Stopping web server...');
    await stopWebServer();

    // Close database
    logger.info('Closing database...');
    closeDatabase();

    logger.info('Shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', error);
    process.exit(1);
  }
}

// Register signal handlers
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection at:', promise, 'reason:', reason);
  shutdown('unhandledRejection');
});

// Start the application
main();
