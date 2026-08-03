import { PrismaClient } from '@prisma/client';

import { isProduction } from './env';

/**
 * Prisma client singleton.
 *
 * One client per process: each instance owns a connection pool, and Neon's pooler
 * will reject connections if we leak them. The globalThis cache stops `tsx watch`
 * from stacking a new pool on every file save.
 *
 * No eager connect — Prisma connects lazily, so a briefly unreachable database
 * doesn't crash-loop the process.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ?? new PrismaClient({ log: ['warn', 'error'] });

if (!isProduction) {
  globalForPrisma.prisma = prisma;
}
