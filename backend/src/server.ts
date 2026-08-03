import type { Server } from 'node:http';

import { createApp } from './app';
import { env } from './config/env';
import { logger } from './config/logger';
import { disconnectPrisma } from './config/prisma';
import { getSupportedProviders } from './automation/provider.registry';

/**
 * Process entry point.
 *
 * Responsible only for lifecycle: bind the port, then shut down cleanly. All
 * HTTP concerns live in `app.ts`.
 *
 * Graceful shutdown is not optional here. Render sends SIGTERM on every deploy,
 * and from Phase 3 onward a running automation owns a browser process — killing
 * it mid-flight leaks Chromium and (from Phase 4) leaves an execution row stuck
 * in RUNNING forever. We stop accepting connections, let in-flight work drain,
 * close the database pool, and hard-exit if draining stalls.
 */
const SHUTDOWN_TIMEOUT_MS = 15_000;

let shuttingDown = false;

function startServer(): Server {
  const app = createApp();

  const server = app.listen(env.PORT, env.HOST, () => {
    logger.info('autopilot backend started', {
      host: env.HOST,
      port: env.PORT,
      environment: env.NODE_ENV,
      providers: getSupportedProviders(),
      nodeVersion: process.version,
    });
  });

  // Slightly above typical proxy idle timeouts, to avoid 502s from races where
  // the proxy reuses a connection we are simultaneously closing.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  server.on('error', (error) => {
    logger.error('http server error', { error });
    process.exit(1);
  });

  return server;
}

/**
 * Releases external resources once the HTTP server has stopped accepting and
 * drained connections, then exits with a status the platform can act on.
 */
async function finalizeShutdown(forceExitTimer: NodeJS.Timeout, closeError?: Error): Promise<void> {
  if (closeError) {
    logger.error('error while closing http server', { error: closeError });
  }

  try {
    await disconnectPrisma();
    logger.info('shutdown complete');
    clearTimeout(forceExitTimer);
    process.exit(0);
  } catch (error) {
    logger.error('error during shutdown', { error });
    process.exit(1);
  }
}

function registerShutdownHandlers(server: Server): void {
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      logger.warn('shutdown already in progress', { signal });
      return;
    }
    shuttingDown = true;

    logger.info('shutdown initiated', { signal, timeoutMs: SHUTDOWN_TIMEOUT_MS });

    const forceExit = setTimeout(() => {
      logger.error('graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    // `server.close` expects a void-returning callback, so the async cleanup is
    // an explicitly-voided call rather than an async callback.
    server.close((closeError) => {
      void finalizeShutdown(forceExit, closeError);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  /**
   * An uncaught exception means the process is in an unknown state. We log and
   * exit rather than pretending to recover — the platform restarts us, and a
   * clean restart is strictly safer than serving from corrupted state.
   */
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception; exiting', { error, stack: error.stack });
    shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection; exiting', { reason });
    shutdown('unhandledRejection');
  });
}

const server = startServer();
registerShutdownHandlers(server);
