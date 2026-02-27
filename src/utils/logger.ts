import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { config } from '../config';
import path from 'path';
import fs from 'fs';

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack }) => {
    return `${timestamp} [${level.toUpperCase()}]: ${message}${stack ? '\n' + stack : ''}`;
  })
);

const transports: winston.transport[] = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      logFormat
    ),
  }),
  new DailyRotateFile({
    filename: path.join('logs', 'reynard-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    maxSize: '10m',
    maxFiles: '14d',
    format: logFormat,
  }),
  new DailyRotateFile({
    filename: path.join('logs', 'error-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    level: 'error',
    maxSize: '10m',
    maxFiles: '30d',
    format: logFormat,
  }),
];

export const logger = winston.createLogger({
  level: config.monitoring.logLevel,
  transports,
});

export default logger;

/**
 * Get recent logs from log files
 */
export function getRecentLogs(maxLines: number = 50): Array<{ time: string; level: string; message: string }> {
  const logsDir = path.join(process.cwd(), 'logs');
  const logs: Array<{ time: string; level: string; message: string }> = [];

  try {
    if (!fs.existsSync(logsDir)) {
      return logs;
    }

    // Get today's log file
    const today = new Date().toISOString().split('T')[0];
    const todayLogFile = path.join(logsDir, `reynard-${today}.log`);

    if (fs.existsSync(todayLogFile)) {
      const content = fs.readFileSync(todayLogFile, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      // Get last N lines
      const recentLines = lines.slice(-maxLines);

      for (const line of recentLines) {
        // Parse: "2024-01-15 21:30:45 [INFO]: message"
        const match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*\[(\w+)\]:\s*(.+)/);
        if (match) {
          logs.push({
            time: match[1],
            level: match[2].toLowerCase(),
            message: match[3],
          });
        }
      }
    }
  } catch (error) {
    // Silently fail if we can't read logs
  }

  return logs.slice(-maxLines); // Return at most maxLines entries
}
