import express from 'express';

import { listProviders, updateProfile } from './controllers/automation.controller';
import {
  authStatus,
  initLogin,
  probe,
  refresh,
  resetSession,
  storeToken,
  verifyOtp,
} from './controllers/auth.controller';
import { getSupportedProviders } from './automation/provider.registry';
import { env } from './config/env';
import { logger } from './config/logger';
import { prisma } from './config/prisma';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { asyncHandler } from './utils/asyncHandler';

const app = express();

// Render terminates TLS upstream, so req.ip must come from X-Forwarded-For.
// `1` trusts exactly one hop; `true` would let clients spoof their IP.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '64kb' }));

// Access log. Emitted on finish so status and duration are known.
app.use((req, res, next) => {
  const start = performance.now();
  res.on('finish', () => {
    const meta = {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(performance.now() - start),
    };
    // Health checks are polled constantly; keep them out of the way.
    if (req.path === '/health') logger.debug('request', meta);
    else if (res.statusCode >= 500) logger.error('request', meta);
    else logger.info('request', meta);
  });
  next();
});

/**
 * Liveness. Deliberately touches nothing — Render's health check points here, and
 * if this queried Postgres a few seconds of Neon latency would get the container
 * restarted, dropping any in-flight automation.
 */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
});

/**
 * POST /api/profile/update — provider-agnostic by contract.
 */
app.post('/api/profile/update', asyncHandler(updateProfile));
app.get('/api/providers', listProviders);

/*
 * Naukri auth. Interactive by necessity — an OTP needs a human — but the goal is to
 * need it once, after which stored cookies let the worker re-login silently.
 *
 *   POST /api/auth/init-login    password login; returns MFA_REQUIRED or a token
 *   POST /api/auth/verify-otp    { otp, flowId } — completes MFA, captures cookies
 *   POST /api/auth/refresh       forces a silent re-login; THE test for unattended use
 *   GET  /api/auth/status        token validity + which cookies are held
 *   GET  /api/auth/probe         resolves a token exactly as the worker does
 *   POST /api/auth/store-token   manual paste-from-browser escape hatch
 *   DELETE /api/auth/session     drop a stale cookie jar
 */
app.post('/api/auth/init-login', asyncHandler(initLogin));
app.post('/api/auth/verify-otp', asyncHandler(verifyOtp));
app.post('/api/auth/refresh', asyncHandler(refresh));
app.get('/api/auth/status', asyncHandler(authStatus));
app.get('/api/auth/probe', asyncHandler(probe));
app.post('/api/auth/store-token', asyncHandler(storeToken));
app.delete('/api/auth/session', asyncHandler(resetSession));

app.use(notFoundHandler);
app.use(errorHandler);

const server = app.listen(env.PORT, () => {
  logger.info('autopilot started', {
    port: env.PORT,
    environment: env.NODE_ENV,
    providers: getSupportedProviders(),
  });
});

// Slightly above typical proxy idle timeouts, to avoid 502s when the proxy reuses
// a connection we are closing at the same moment.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

/**
 * Graceful shutdown. Render sends SIGTERM on every deploy, and from Phase 3 a
 * running automation owns a browser process — killing it mid-flight leaks Chromium
 * and (from Phase 4) leaves a history row stuck in RUNNING.
 */
let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down', { signal });

  const force = setTimeout(() => {
    logger.error('shutdown timed out; forcing exit');
    process.exit(1);
  }, 15_000);
  force.unref();

  server.close(() => {
    void prisma.$disconnect().finally(() => {
      clearTimeout(force);
      process.exit(0);
    });
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// An uncaught error leaves the process in an unknown state. Exit and let the
// platform restart us — cleaner than serving from corrupted state.
process.on('uncaughtException', (error) => {
  logger.error('uncaught exception', { error: error.message, stack: error.stack });
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled rejection', { reason: String(reason) });
  shutdown('unhandledRejection');
});
