import dotenv from 'dotenv';
import { Config } from '../types';
import path from 'path';
import fs from 'fs';

dotenv.config();

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value === undefined && defaultValue === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value || defaultValue!;
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const num = parseInt(value, 10);
  if (isNaN(num)) {
    throw new Error(`Invalid number for environment variable ${key}: ${value}`);
  }
  return num;
}

function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true';
}

function getEnvArray(key: string, defaultValue: string[] = []): string[] {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export const config: Config = {
  vision: {
    provider: getEnv('VISION_PROVIDER', 'ollama') as 'ollama' | 'openai' | 'anthropic' | 'disabled',
    model: getEnv('VISION_MODEL', 'llava'),
    apiUrl: process.env.VISION_API_URL,
    apiKey: process.env.VISION_API_KEY,
    temperature: getEnvNumber('VISION_TEMPERATURE', 0.1),
    maxTokens: getEnvNumber('VISION_MAX_TOKENS', 1000),
    // 消息提取模式: 'vlm' = VLM截图识别, 'text' = 聊天记录文本+OCR
    extractMode: getEnv('EXTRACT_MODE', 'vlm') as 'vlm' | 'text',
  },
  capture: {
    enabled: getEnvBoolean('CAPTURE_ENABLED', true),
    windowName: getEnv('CAPTURE_WINDOW_NAME', '微信'),
    saveScreenshots: getEnvBoolean('CAPTURE_SAVE_SCREENSHOTS', false),
    screenshotDir: getEnv('CAPTURE_SCREENSHOT_DIR', 'data/screenshots'),
  },
  web: {
    port: getEnvNumber('WEB_PORT', 3000),
    host: getEnv('WEB_HOST', '0.0.0.0'),
    enabled: getEnvBoolean('WEB_ENABLED', true),
  },
  database: {
    path: getEnv('DATABASE_PATH', 'data/reynard.db'),
  },
  webhook: {
    url: process.env.WEBHOOK_URL,
    enabled: getEnvBoolean('WEBHOOK_ENABLED', false),
    batchSize: getEnvNumber('WEBHOOK_BATCH_SIZE', 10),
    batchInterval: getEnvNumber('WEBHOOK_BATCH_INTERVAL', 5),
  },
  monitoring: {
    rooms: getEnvArray('MONITORED_ROOMS', []),
    logLevel: getEnv('LOG_LEVEL', 'info'),
  },
  bot: {
    // 目标列表格式: "群名1|群聊,群名2|联系人,好友名1|联系人"
    targets: parseBotTargets(getEnv('BOT_TARGETS', '')),
    greetingMessage: getEnv('BOT_GREETING_MESSAGE', 'Reynard 机器人已上线'),
    greetingEnabled: getEnvBoolean('PATROL_GREETING_ENABLED', false),
    delayBetweenTargets: getEnvNumber('BOT_DELAY_BETWEEN_TARGETS', 2000),
  },
  ocr: {
    // OCR预处理：缩放倍数
    resizeScale: getEnvNumber('OCR_RESIZE_SCALE', 3),
    // OCR预处理：对比度增益
    contrastGain: getEnvNumber('OCR_CONTRAST_GAIN', 1.5),
    // OCR预处理：亮度偏移
    brightnessOffset: getEnvNumber('OCR_BRIGHTNESS_OFFSET', -20),
    // 搜索结果加载等待时间（毫秒）
    searchLoadWait: getEnvNumber('OCR_SEARCH_LOAD_WAIT', 2500),
  },
  patrol: {
    // 巡逻间隔（毫秒）
    interval: getEnvNumber('PATROL_INTERVAL', 20000),
    // 每次巡逻目标之间的等待时间（毫秒）
    targetDelay: getEnvNumber('PATROL_TARGET_DELAY', 500),
    // 最大巡逻轮数（0 = 无限）
    maxRounds: getEnvNumber('PATROL_MAX_ROUNDS', 0),
  },
  vlm: {
    // VLM 分析周期间隔（毫秒）
    cycleInterval: getEnvNumber('VLM_CYCLE_INTERVAL', 60000),
    // 拼合图最大高度（像素）
    maxImageHeight: getEnvNumber('VLM_MAX_IMAGE_HEIGHT', 4000),
    // 处理后是否删除截图
    cleanupProcessed: getEnvBoolean('VLM_CLEANUP_PROCESSED', true),
  },
};

// 解析 BOT_TARGETS 环境变量
function parseBotTargets(value: string): Array<{ name: string; category: string }> {
  if (!value) return [];
  return value.split(',').map(s => {
    const parts = s.split('|');
    return {
      name: parts[0]?.trim() || '',
      category: parts[1]?.trim() || '联系人',
    };
  }).filter(t => t.name);
}

// Ensure directories exist
ensureDir(path.dirname(config.database.path));
ensureDir(config.capture.screenshotDir);
ensureDir('logs');
