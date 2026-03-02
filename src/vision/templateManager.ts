/**
 * Template Manager for WeChat UI elements
 *
 * Loads and caches template images for matching
 */
import cv from 'opencv4nodejs-prebuilt';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger.js';

export interface TemplateInfo {
  name: string;
  mat: cv.Mat;
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
          const mat = cv.imread(templatePath);
          if (!mat.empty) {
            this.templates.set(name, { name, mat, path: templatePath });
            logger.info(`[TemplateManager] Loaded template: ${name}`);
          }
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

  getTemplate(name: string): cv.Mat | null {
    const template = this.templates.get(name);
    return template ? template.mat : null;
  }

  hasTemplate(name: string): boolean {
    return this.templates.has(name);
  }

  getAllTemplateNames(): string[] {
    return Array.from(this.templates.keys());
  }

  addTemplate(name: string, imagePath: string): void {
    const mat = cv.imread(imagePath);
    if (!mat.empty) {
      this.templates.set(name, { name, mat, path: imagePath });
      logger.info(`[TemplateManager] Added template: ${name}`);
    }
  }

  dispose(): void {
    for (const template of this.templates.values()) {
      template.mat.delete();
    }
    this.templates.clear();
    this.initialized = false;
  }
}

export const templateManager = new TemplateManager();
