import express, { Express } from 'express';
import cors from 'cors';
import { config } from '../config';
import { createRoutes } from './routes';
import logger from '../utils/logger';

let server: any = null;

/**
 * Start the web server
 */
export function startWebServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!config.web.enabled) {
      logger.info('Web UI is disabled');
      return resolve();
    }

    const app: Express = express();

    // Middleware
    app.use(cors());
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // Request logging
    app.use((req, res, next) => {
      logger.debug(`${req.method} ${req.path}`);
      next();
    });

    // Routes
    app.use('/', createRoutes());

    // Error handler
    app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
      logger.error('Express error:', err);
      res.status(500).json({
        error: 'Internal server error',
        message: err.message,
      });
    });

    // Start server
    server = app.listen(config.web.port, config.web.host, () => {
      logger.info(`Web UI started at http://${config.web.host}:${config.web.port}`);
      logger.info(`Login page: http://localhost:${config.web.port}/login`);
      resolve();
    });

    server.on('error', (error: Error) => {
      logger.error('Failed to start web server:', error);
      reject(error);
    });
  });
}

/**
 * Stop the web server
 */
export function stopWebServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      return resolve();
    }

    server.close(() => {
      logger.info('Web server stopped');
      server = null;
      resolve();
    });
  });
}
