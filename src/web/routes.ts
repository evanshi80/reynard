import { Router, Request, Response } from 'express';
import { config } from '../config';
import { getMonitor } from '../capture/monitor';
import { createVisionProvider } from '../vision/providers';
import { getDatabase } from '../database/client';
import * as wechat from '../wechat';
import path from 'path';
import logger from '../utils/logger';

interface StatusResponse {
  monitor: {
    running: boolean;
    messagesCollected: number;
    errors: number;
    seenCount: number;
    lastCapture?: string;
    lastRecognize?: string;
  };
  vision: {
    provider: string;
    model: string;
    available: boolean;
  };
  capture: {
    enabled: boolean;
    interval: number;
    windowName: string;
  };
  messages: Array<{
    roomName: string;
    talkerName: string;
    content: string;
    timestamp: number;
  }>;
  logs: Array<{
    time: string;
    level: string;
    message: string;
  }>;
}

/**
 * Create Express router with all routes
 */
export function createRoutes(): Router {
  const router = Router();

  // Home page - redirect to monitor
  router.get('/', (req: Request, res: Response) => {
    res.redirect('/monitor');
  });

  // Monitor page
  router.get('/monitor', (req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, '..', '..', 'data', 'monitor.html'));
  });

  // Login page
  router.get('/login', (req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, 'views', 'login.html'));
  });

  // API: Get full status
  router.get('/api/status', (req: Request, res: Response) => {
    try {
      const monitor = getMonitor();
      const provider = createVisionProvider();

      // Get recent messages from database
      const db = getDatabase();
      const limit = parseInt(req.query.limit as string) || 200;
      const recentMessages = db.prepare(`
        SELECT room_name, talker_name, content, timestamp
        FROM messages
        ORDER BY timestamp DESC
        LIMIT ?
      `).all(limit) as Array<{
        room_name: string;
        talker_name: string;
        content: string;
        timestamp: number;
      }>;

      const response: StatusResponse = {
        monitor: {
          running: monitor.getStatus().running,
          messagesCollected: monitor.getStatus().messagesCollected,
          errors: monitor.getStatus().errors,
          seenCount: monitor.getSeenCount(),
          lastCapture: monitor.getStatus().lastCapture,
          lastRecognize: monitor.getStatus().lastRecognize,
        },
        vision: {
          provider: provider.getName(),
          model: config.vision.model,
          available: false, // Will be updated async if needed
        },
        capture: {
          enabled: config.capture.enabled,
          interval: config.capture.interval,
          windowName: config.capture.windowName,
        },
        messages: recentMessages.map(m => ({
          roomName: m.room_name,
          talkerName: m.talker_name,
          content: m.content,
          timestamp: m.timestamp,
        })),
        logs: [],
      };

      res.json(response);
    } catch (error) {
      logger.error('Failed to get status:', error);
      res.status(500).json({ error: 'Failed to get status' });
    }
  });

  // API: Get vision provider status
  router.get('/api/vision/status', async (req: Request, res: Response) => {
    try {
      const provider = createVisionProvider();
      const available = await provider.isAvailable();

      res.json({
        provider: provider.getName(),
        model: config.vision.model,
        available,
      });
    } catch (error) {
      logger.error('Failed to get vision status:', error);
      res.status(500).json({ error: 'Failed to get vision status' });
    }
  });

  // API: Get recent messages
  router.get('/api/messages', (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const db = getDatabase();

      const messages = db.prepare(`
        SELECT * FROM messages
        ORDER BY timestamp DESC
        LIMIT ?
      `).all(limit);

      res.json({ messages });
    } catch (error) {
      logger.error('Failed to get messages:', error);
      res.status(500).json({ error: 'Failed to get messages' });
    }
  });

  // API: Get message count
  router.get('/api/messages/count', (req: Request, res: Response) => {
    try {
      const db = getDatabase();
      const result = db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };
      res.json({ count: result.count });
    } catch (error) {
      logger.error('Failed to get message count:', error);
      res.status(500).json({ error: 'Failed to get message count' });
    }
  });

  // API: Clear message cache
  router.post('/api/monitor/clear', (req: Request, res: Response) => {
    try {
      const monitor = getMonitor();
      monitor.clearCache();
      res.json({ success: true });
    } catch (error) {
      logger.error('Failed to clear cache:', error);
      res.status(500).json({ error: 'Failed to clear cache' });
    }
  });

  // API: WeChat - Send message to a contact/group
  router.post('/api/wechat/send', async (req: Request, res: Response) => {
    try {
      const { contact, message } = req.body;
      if (!contact || !message) {
        return res.status(400).json({ error: 'Both "contact" and "message" are required' });
      }

      if (!wechat.isAhkAvailable()) {
        return res.status(503).json({
          error: 'AutoHotkey is not available. Install from https://www.autohotkey.com/ or set AHK_PATH env var.',
        });
      }

      const success = await wechat.sendToContact(contact, message);
      if (success) {
        res.json({ success: true, contact, message });
      } else {
        res.status(500).json({ error: 'Failed to send message via WeChat' });
      }
    } catch (error) {
      logger.error('WeChat send error:', error);
      res.status(500).json({ error: 'Failed to send message' });
    }
  });

  // API: WeChat - Open a chat window
  router.post('/api/wechat/open', async (req: Request, res: Response) => {
    try {
      const { contact } = req.body;
      if (!contact) {
        return res.status(400).json({ error: '"contact" is required' });
      }

      if (!wechat.isAhkAvailable()) {
        return res.status(503).json({
          error: 'AutoHotkey is not available.',
        });
      }

      const success = await wechat.openChat(contact);
      if (success) {
        res.json({ success: true, contact });
      } else {
        res.status(500).json({ error: 'Failed to open chat' });
      }
    } catch (error) {
      logger.error('WeChat open error:', error);
      res.status(500).json({ error: 'Failed to open chat' });
    }
  });

  // API: WeChat - Activate WeChat window
  router.post('/api/wechat/activate', async (req: Request, res: Response) => {
    try {
      if (!wechat.isAhkAvailable()) {
        return res.status(503).json({
          error: 'AutoHotkey is not available.',
        });
      }

      const success = await wechat.activateWeChat();
      if (success) {
        res.json({ success: true });
      } else {
        res.status(500).json({ error: 'Failed to activate WeChat window' });
      }
    } catch (error) {
      logger.error('WeChat activate error:', error);
      res.status(500).json({ error: 'Failed to activate WeChat' });
    }
  });

  // API: WeChat - Check AHK availability
  router.get('/api/wechat/status', (req: Request, res: Response) => {
    res.json({
      ahkAvailable: wechat.isAhkAvailable(),
    });
  });

  // API: Health check
  router.get('/api/health', (req: Request, res: Response) => {
    res.json({
      status: 'ok',
      timestamp: Date.now(),
      uptime: process.uptime(),
    });
  });

  return router;
}
