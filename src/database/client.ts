import Database from 'better-sqlite3';
import { config } from '../config';
import { SCHEMA_SQL } from './schema';
import logger from '../utils/logger';
import path from 'path';
import fs from 'fs';

let db: Database.Database | null = null;

/**
 * Initialize the database connection and create tables
 */
export function initDatabase(): Database.Database {
  if (db) {
    return db;
  }

  try {
    // Ensure data directory exists
    const dbPath = config.database.path;
    const dbDir = path.dirname(dbPath);

    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
      logger.info(`Created database directory: ${dbDir}`);
    }

    // Open database connection
    db = new Database(dbPath, {
      verbose: config.monitoring.logLevel === 'debug' ? logger.debug.bind(logger) : undefined,
    });

    // Enable WAL mode for better concurrent performance
    db.pragma('journal_mode = WAL');

    // Execute schema creation
    db.exec(SCHEMA_SQL);

    logger.info(`Database initialized at: ${dbPath}`);
    return db;
  } catch (error) {
    logger.error('Failed to initialize database', error);
    throw error;
  }
}

/**
 * Get the database instance
 */
export function getDatabase(): Database.Database {
  if (!db) {
    return initDatabase();
  }
  return db;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Database connection closed');
  }
}

// Handle cleanup on process exit
process.on('exit', () => {
  closeDatabase();
});

process.on('SIGINT', () => {
  closeDatabase();
  process.exit(0);
});

process.on('SIGTERM', () => {
  closeDatabase();
  process.exit(0);
});
