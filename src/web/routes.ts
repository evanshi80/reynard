import { Router, Request, Response } from 'express';
import { config, updateConfig, saveConfigToEnv } from '../config';
import { getMonitor } from '../capture/monitor';
import { createVisionProvider } from '../vision/providers';
import { getDatabase } from '../database/client';
import { getRecentLogs } from '../utils/logger';
import { getPatrolStatus, startPatrol, stopPatrol } from '../bot';
import * as wechat from '../wechat';
import { withAhkLock } from '../wechat/ahkBridge';
import path from 'path';
import fs from 'fs';
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
        SELECT room_name, talker_name, content, timestamp, msg_index
        FROM messages
        ORDER BY timestamp DESC, msg_index ASC
        LIMIT ?
      `).all(limit) as Array<{
        room_name: string;
        talker_name: string;
        content: string;
        timestamp: number;
        msg_index: number;
      }>;

      // Get recent logs
      const recentLogs = getRecentLogs(20);

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
          interval: config.patrol.interval,
          windowName: config.capture.windowName,
        },
        messages: recentMessages.map(m => ({
          roomName: m.room_name,
          talkerName: m.talker_name,
          content: m.content,
          timestamp: m.timestamp,
        })),
        logs: recentLogs,
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
      const since = req.query.since ? parseInt(req.query.since as string) : undefined;
      const until = req.query.until ? parseInt(req.query.until as string) : undefined;
      const room = req.query.room as string | undefined;
      const db = getDatabase();

      let query = 'SELECT * FROM messages';
      const params: (string | number)[] = [];
      const conditions: string[] = [];

      if (since !== undefined) {
        conditions.push('timestamp >= ?');
        params.push(since);
      }
      if (until !== undefined) {
        conditions.push('timestamp <= ?');
        params.push(until);
      }
      if (room) {
        conditions.push('room_name = ?');
        params.push(room);
      }

      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      }

      query += ' ORDER BY timestamp DESC, msg_index ASC LIMIT ?';
      params.push(limit);

      const messages = db.prepare(query).all(...params);

      res.json({ messages });
    } catch (error) {
      logger.error('Failed to get messages:', error);
      res.status(500).json({ error: 'Failed to get messages' });
    }
  });

  // API: Get all room names
  router.get('/api/messages/rooms', (req: Request, res: Response) => {
    try {
      const db = getDatabase();
      const rooms = db.prepare(`
        SELECT DISTINCT room_name FROM messages ORDER BY room_name
      `).all() as Array<{ room_name: string }>;
      res.json({ rooms: rooms.map(r => r.room_name) });
    } catch (error) {
      logger.error('Failed to get rooms:', error);
      res.status(500).json({ error: 'Failed to get rooms' });
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
      const { contact, message, category } = req.body;
      logger.info(`[wechat/send] contact="${contact}", category="${category || '未指定(默认联系人)'}"`);

      if (!contact || !message) {
        return res.status(400).json({ error: 'Both "contact" and "message" are required' });
      }

      if (!wechat.isAhkAvailable()) {
        return res.status(503).json({
          error: 'AutoHotkey is not available. Install from https://www.autohotkey.com/ or set AHK_PATH env var.',
        });
      }

      // Use lock to prevent conflict with patrol
      const success = await withAhkLock(async () => {
        return await wechat.sendToContact(contact, message, category || '联系人');
      });
      if (success) {
        res.json({ success: true, contact, message, category: category || '联系人' });
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
      const { contact, category } = req.body;
      logger.info(`[wechat/open] contact="${contact}", category="${category || '未指定(默认联系人)'}"`);

      if (!contact) {
        return res.status(400).json({ error: '"contact" is required' });
      }

      if (!wechat.isAhkAvailable()) {
        return res.status(503).json({
          error: 'AutoHotkey is not available.',
        });
      }

      // Use lock to prevent conflict with patrol
      const success = await withAhkLock(async () => {
        return await wechat.openChat(contact, category || '联系人');
      });
      if (success) {
        res.json({ success: true, contact, category: category || '联系人' });
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

      // Use lock to prevent conflict with patrol
      const success = await withAhkLock(async () => {
        return await wechat.activateWeChat();
      });
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

  // API: Get recent logs
  router.get('/api/logs', (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const logs = getRecentLogs(limit);
      res.json({ logs });
    } catch (error) {
      logger.error('Failed to get logs:', error);
      res.status(500).json({ error: 'Failed to get logs' });
    }
  });

  // API: Health check
  router.get('/api/health', (req: Request, res: Response) => {
    res.json({
      status: 'ok',
      timestamp: Date.now(),
      uptime: process.uptime(),
    });
  });

  // API: Get skill definition (for OpenClaw integration)
  router.get('/api/skills/definition', (req: Request, res: Response) => {
    try {
      const status = getPatrolStatus();
      res.json({
        name: 'wechat-monitor',
        description: '查询和分析微信群聊消息',
        version: '1.0.0',
        endpoints: {
          messages: {
            rooms: '/api/messages/rooms',
            messages: '/api/messages',
            count: '/api/messages/count',
          },
          patrol: {
            status: '/api/patrol/status',
            start: '/api/patrol/start',
            stop: '/api/patrol/stop',
            config: '/api/patrol/config',
          },
          wechat: {
            send: '/api/wechat/send',
            open: '/api/wechat/open',
            activate: '/api/wechat/activate',
          },
        },
        currentStatus: {
          patrol: {
            running: status.running,
            roundCount: status.roundCount,
            backoffLevel: status.backoffLevel,
            currentInterval: status.currentInterval,
            targets: status.targets,
            lastMessageTime: status.lastMessageTime,
          },
        },
        // Query parameter schemas
        schemas: {
          messages: {
            since: 'number (Unix ms)',
            until: 'number (Unix ms)',
            room: 'string',
            limit: 'number (default 100)',
          },
          patrolConfig: {
            patrolInterval: 'number (ms, min 1000)',
            patrolMaxRounds: 'number (0 = unlimited)',
            targets: 'array of {name, category}',
          },
        },
      });
    } catch (error) {
      logger.error('Failed to get skill definition:', error);
      res.status(500).json({ error: 'Failed to get skill definition' });
    }
  });

  // API: Get latest skill files (for OpenClaw to download and update)
  router.get('/api/skills/latest', (req: Request, res: Response) => {
    try {
      // Get base URL from request host
      const host = req.get('host') || 'localhost:3000';
      const protocol = req.protocol;
      const baseUrl = `${protocol}://${host}`;

      // Read SKILL.md
      const skillPath = path.join(process.cwd(), 'skills', 'wechat-monitor', 'SKILL.md');
      const skillContent = fs.existsSync(skillPath)
        ? fs.readFileSync(skillPath, 'utf-8')
        : '';

      // Generate config.json with dynamic baseUrl
      const configContent = JSON.stringify({
        name: 'wechat-monitor',
        description: '查询和分析微信群聊消息',
        version: '1.0.0',
        api: {
          baseUrl,
          endpoints: {
            definition: '/api/skills/definition',
            latest: '/api/skills/latest',
            rooms: '/api/messages/rooms',
            messages: '/api/messages',
            patrolStatus: '/api/patrol/status',
            patrolStart: '/api/patrol/start',
            patrolStop: '/api/patrol/stop',
            patrolConfig: '/api/patrol/config',
          },
        },
        config: {
          defaultLimit: 100,
          minPollInterval: 10000,
        },
      }, null, 2);

      res.json({
        skill: skillContent,
        config: configContent,
        baseUrl,
      });
    } catch (error) {
      logger.error('Failed to get latest skill:', error);
      res.status(500).json({ error: 'Failed to get latest skill' });
    }
  });

  // API: Get patrol status
  router.get('/api/patrol/status', (req: Request, res: Response) => {
    try {
      const status = getPatrolStatus();
      res.json(status);
    } catch (error) {
      logger.error('Failed to get patrol status:', error);
      res.status(500).json({ error: 'Failed to get patrol status' });
    }
  });

  // API: Start patrol
  router.post('/api/patrol/start', async (req: Request, res: Response) => {
    try {
      await startPatrol();
      res.json({ success: true });
    } catch (error) {
      logger.error('Failed to start patrol:', error);
      res.status(500).json({ error: 'Failed to start patrol' });
    }
  });

  // API: Stop patrol
  router.post('/api/patrol/stop', (req: Request, res: Response) => {
    try {
      stopPatrol();
      res.json({ success: true });
    } catch (error) {
      logger.error('Failed to stop patrol:', error);
      res.status(500).json({ error: 'Failed to stop patrol' });
    }
  });

  // API: Update patrol config
  router.post('/api/patrol/config', (req: Request, res: Response) => {
    try {
      const { patrolInterval, patrolMaxRounds, targets } = req.body;

      const updates: {
        patrolInterval?: number;
        patrolMaxRounds?: number;
        targets?: Array<{ name: string; category: string }>;
      } = {};

      if (patrolInterval !== undefined) {
        if (typeof patrolInterval !== 'number' || patrolInterval < 1000) {
          return res.status(400).json({ error: 'patrolInterval must be a number >= 1000' });
        }
        updates.patrolInterval = patrolInterval;
      }

      if (patrolMaxRounds !== undefined) {
        if (typeof patrolMaxRounds !== 'number' || patrolMaxRounds < 0) {
          return res.status(400).json({ error: 'patrolMaxRounds must be a number >= 0' });
        }
        updates.patrolMaxRounds = patrolMaxRounds;
      }

      if (targets !== undefined) {
        if (!Array.isArray(targets)) {
          return res.status(400).json({ error: 'targets must be an array' });
        }
        updates.targets = targets;
      }

      updateConfig(updates);
      saveConfigToEnv(); // Save to .env for persistence
      logger.info('Patrol config updated:', updates);

      res.json({ success: true, config: getPatrolStatus() });
    } catch (error) {
      logger.error('Failed to update patrol config:', error);
      res.status(500).json({ error: 'Failed to update patrol config' });
    }
  });

  return router;
}
