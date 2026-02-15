import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import logger from '../utils/logger';

export interface AhkResult {
  success: boolean;
  action: string;
  message: string;
}

const AHK_SEARCH_PATHS = [
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'AutoHotkey', 'v2', 'AutoHotkey64.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'AutoHotkey', 'v2', 'AutoHotkey32.exe'),
  'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe',
  'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey32.exe',
  'C:\\Program Files\\AutoHotkey\\AutoHotkey.exe',
  'C:\\Program Files (x86)\\AutoHotkey\\AutoHotkey.exe',
];

const SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'wechat.ahk');

function findAhkExecutable(): string | null {
  if (process.env.AHK_PATH && fs.existsSync(process.env.AHK_PATH)) {
    return process.env.AHK_PATH;
  }
  for (const p of AHK_SEARCH_PATHS) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

let cachedAhkPath: string | null | undefined;

function getAhkPath(): string {
  if (cachedAhkPath === undefined) cachedAhkPath = findAhkExecutable();
  if (!cachedAhkPath) {
    throw new Error('AutoHotkey not found. Install from https://www.autohotkey.com/ or set AHK_PATH.');
  }
  return cachedAhkPath;
}

function executeAhk(args: string[], timeoutMs: number = 15000, retries: number = 2): Promise<AhkResult> {
  return new Promise((resolve, reject) => {
    const ahkPath = getAhkPath();
    if (!fs.existsSync(SCRIPT_PATH)) {
      reject(new Error(`AHK script not found: ${SCRIPT_PATH}`));
      return;
    }

    const fullArgs = [SCRIPT_PATH, ...args];
    logger.debug(`AHK: ${fullArgs.join(' ')}`);

    execFile(ahkPath, fullArgs, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (stderr) logger.warn(`AHK stderr: ${stderr}`);

      const output = stdout.trim();

      if (!output || error) {
        // Retry logic
        if (retries > 0) {
          logger.warn(`AHK call failed, retrying... (${retries} left)`);
          return executeAhk(args, timeoutMs, retries - 1).then(resolve).catch(reject);
        }
        reject(new Error(`AHK failed: ${error?.message || 'no output'}`));
        return;
      }

      try {
        const result: AhkResult = JSON.parse(output);
        logger.debug(`AHK ${result.action}: ${result.message}`);
        resolve(result);
      } catch {
        reject(new Error(`Invalid AHK output: ${output}`));
      }
    });
  });
}

export async function activateWeChat(): Promise<AhkResult> {
  return executeAhk(['activate']);
}

export async function typeSearch(text: string): Promise<AhkResult> {
  logger.info(`[ahkBridge] typeSearch called with: ${text}`);
  return executeAhk(['type_search', text]);
}

export async function openFirstResult(name: string): Promise<AhkResult> {
  return executeAhk(['open_first', name]);
}

export async function navigateToResult(name: string, downCount: number): Promise<AhkResult> {
  return executeAhk(['navigate', name, String(downCount)]);
}

export async function clickAt(x: number, y: number): Promise<AhkResult> {
  return executeAhk(['click', String(x), String(y)]);
}

export async function sendMessage(message: string): Promise<AhkResult> {
  return executeAhk(['send', message]);
}

export async function sendToContact(contact: string, message: string): Promise<AhkResult> {
  return executeAhk(['sendto', contact, message]);
}

export async function scrollToTop(winX?: number, winY?: number, winW?: number, winH?: number): Promise<AhkResult> {
  return executeAhk(['scroll_home', String(winX || 0), String(winY || 0), String(winW || 0), String(winH || 0)]);
}

export async function scrollUp(): Promise<AhkResult> {
  return executeAhk(['scroll_up']);
}

// Async mutex for serializing AHK operations
let lockChain: Promise<void> = Promise.resolve();

export function withAhkLock<T>(fn: () => Promise<T>): Promise<T> {
  let release: () => void;
  const next = new Promise<void>(r => { release = r; });
  const prev = lockChain;
  lockChain = next;
  return prev.then(async () => {
    try {
      return await fn();
    } finally {
      release!();
    }
  });
}

export function isAhkAvailable(): boolean {
  try {
    getAhkPath();
    return fs.existsSync(SCRIPT_PATH);
  } catch { return false; }
}
