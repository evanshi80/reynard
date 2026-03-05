/**
 * Template Manager for WeChat UI elements
 *
 * Loads and caches template images for matching
 * Uses Sharp for image loading
 */
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger.js';

export interface TemplateInfo {
  name: string;
  data: Buffer;
  width: number;
  height: number;
  path: string;
}

const TEMPLATE_DIR = path.resolve(process.cwd(), 'data', 'templates');

const DEFAULT_TEMPLATES: Record<string, string> = {
  // WeChat image icon
  'image': 'image.png',
  // WeChat file icon
  'file': 'file.png',
  // WeChat voice icon
  'voice': 'voice.png',
  // WeChat video icon
  'video': 'video.png',
};

class TemplateManager {
  private templates: Map<string, TemplateInfo> = new Map();
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info('[TemplateManager] Initializing...');

    // Ensure template directory exists
    if (!fs.existsSync(TEMPLATE_DIR)) {
      fs.mkdirSync(TEMPLATE_DIR, { recursive: true });
      logger.warn(`[TemplateManager] Created templates directory: ${TEMPLATE_DIR}`);
      logger.warn('[TemplateManager] Please add template images to this directory');
    }

    // Load default templates
    for (const [name, filename] of Object.entries(DEFAULT_TEMPLATES)) {
      const templatePath = path.join(TEMPLATE_DIR, filename);
      if (fs.existsSync(templatePath)) {
        try {
          const metadata = await sharp(templatePath).metadata();
          const data = await sharp(templatePath).raw().toBuffer();

          this.templates.set(name, {
            name,
            data,
            width: metadata.width || 0,
            height: metadata.height || 0,
            path: templatePath
          });
          logger.info(`[TemplateManager] Loaded template: ${name}`);
        } catch (err) {
          logger.error(`[TemplateManager] Failed to load template ${name}:`, err);
        }
      } else {
        logger.debug(`[TemplateManager] Template not found: ${templatePath}`);
      }
    }

    this.initialized = true;
    logger.info(`[TemplateManager] Loaded ${this.templates.size} templates`);
  }

  getTemplate(name: string): TemplateInfo | null {
    return this.templates.get(name) || null;
  }

  hasTemplate(name: string): boolean {
    return this.templates.has(name);
  }

  getAllTemplateNames(): string[] {
    return Array.from(this.templates.keys());
  }

  async addTemplate(name: string, imagePath: string): Promise<void> {
    try {
      const metadata = await sharp(imagePath).metadata();
      const data = await sharp(imagePath).raw().toBuffer();

      this.templates.set(name, {
        name,
        data,
        width: metadata.width || 0,
        height: metadata.height || 0,
        path: imagePath
      });
      logger.info(`[TemplateManager] Added template: ${name}`);
    } catch (err) {
      logger.error(`[TemplateManager] Failed to add template ${name}:`, err);
    }
  }

  dispose(): void {
    this.templates.clear();
    this.initialized = false;
  }
}

export const templateManager = new TemplateManager();
