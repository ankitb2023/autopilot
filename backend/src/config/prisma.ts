import { PrismaClient } from '@prisma/client';

import { isProduction } from './env';
import { logger } from './logger';

/**
 * Prisma client singleton.
 *
 * A single client per process, because each instance owns its own connection
 * pool — and Neon's pooler will start rejecting connections if we leak clients.
 * The `globalThis` cache exists purely so `tsx watch` hot reloads don't stack up
 * new pools on every file save during development.
 *
 * We do NOT connect eagerly at boot. Prisma connects lazily on first query,
 * which means a temporarily unreachable database delays readiness instead of
 * crash-looping the container. `/health/ready` is what surfaces the truth.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    log: isProduction
      ? [
          { emit: 'event', level: 'warn' },
          { emit: 'event', level: 'error' },
        ]
      : [
          { emit: 'event', level: 'query' },
          { emit: 'event', level: 'warn' },
          { emit: 'event', level: 'error' },
        ],
  });

  // Route Prisma's own diagnostics through Winston so there is one log stream.
  client.$on('warn', (event) => logger.warn('prisma warning', { message: event.message }));
  client.$on('error', (event) => logger.error('prisma error', { message: event.message }));

  if (!isProduction) {
    client.$on('query', (event) => {
      logger.debug('prisma query', { durationMs: event.duration, query: event.query });
    });
  }

  return client;
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (!isProduction) {
  globalForPrisma.prisma = prisma;
}

/** Cheap round-trip used by the readiness probe. */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    logger.error('database connectivity check failed', { error });
    return false;
  }
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
