import type { Request, Response } from 'express';

import { env } from '../config/env';
import { checkDatabaseConnection } from '../config/prisma';
import { ErrorCode } from '../core/errors';
import { sendError, sendSuccess } from '../core/httpResponse';

/**
 * Liveness — GET /health
 *
 * Intentionally dependency-free and always 200 while the process can serve
 * traffic. Render's health check points here: if this touched the database, a
 * few seconds of Neon latency would get the container killed and restarted,
 * which fixes nothing and drops in-flight automations.
 */
export function getHealth(_req: Request, res: Response): void {
  sendSuccess(res, {
    status: 'ok',
    environment: env.NODE_ENV,
    uptimeSeconds: Math.round(process.uptime()),
    version: process.env.npm_package_version ?? '0.1.0',
  });
}

/**
 * Readiness — GET /health/ready
 *
 * Reports whether dependencies are actually usable. Returns 503 when the
 * database is unreachable, which is the correct signal for a deploy gate or an
 * uptime monitor.
 */
export async function getReadiness(_req: Request, res: Response): Promise<void> {
  const databaseReachable = await checkDatabaseConnection();

  const payload = {
    status: databaseReachable ? 'ready' : 'degraded',
    checks: { database: databaseReachable ? 'up' : 'down' },
  };

  if (!databaseReachable) {
    sendError(
      res,
      503,
      ErrorCode.SERVICE_UNAVAILABLE,
      'One or more dependencies are unavailable.',
      payload.checks,
    );
    return;
  }

  sendSuccess(res, payload);
}
