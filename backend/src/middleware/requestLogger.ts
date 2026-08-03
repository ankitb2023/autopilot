import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { logger } from '../config/logger';

/**
 * Access logging.
 *
 * Hand-rolled rather than Morgan: we already have Winston with correlation IDs,
 * and a second logging stack with its own format would fragment the log stream
 * that Phase 6's dashboard has to read.
 *
 * Logged on `finish` so status code and duration are known. Health probes are
 * logged at `debug` to keep production logs readable — Render polls them
 * constantly and they would otherwise drown out real traffic.
 */
const QUIET_PATHS = new Set(['/health', '/health/ready', '/health/live']);

export function requestLogger(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = performance.now();

    res.on('finish', () => {
      const durationMs = Math.round(performance.now() - startedAt);

      const meta = {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs,
        ip: req.ip,
        userAgent: req.header('user-agent'),
      };

      if (QUIET_PATHS.has(req.path)) {
        logger.debug('request completed', meta);
      } else if (res.statusCode >= 500) {
        logger.error('request failed', meta);
      } else if (res.statusCode >= 400) {
        logger.warn('request rejected', meta);
      } else {
        logger.info('request completed', meta);
      }
    });

    next();
  };
}
