import path from 'node:path';

import dotenv from 'dotenv';
import { z } from 'zod';

/**
 * Environment configuration.
 *
 * Parsed and validated exactly once, at process boot. If the environment is
 * invalid the process exits immediately with a readable report — we never want
 * to discover a missing DATABASE_URL halfway through a scheduled 3am run.
 *
 * `.env` is only loaded for local development. In Render / GitHub Actions the
 * variables are injected by the platform, and dotenv is a no-op.
 */
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const NodeEnv = z.enum(['development', 'test', 'production']);

const envSchema = z.object({
  NODE_ENV: NodeEnv.default('development'),

  /* HTTP */
  PORT: z.coerce.number().int().positive().max(65535).default(8080),
  HOST: z.string().min(1).default('0.0.0.0'),

  /**
   * Comma-separated list of allowed browser origins, or `*` for any.
   * Tightened once the Next.js dashboard (Phase 6) has a real domain.
   */
  CORS_ORIGINS: z.string().default('*'),

  /* Observability */
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'debug']).default('info'),

  /* Persistence */
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine((value) => value.startsWith('postgres://') || value.startsWith('postgresql://'), {
      message: 'DATABASE_URL must be a PostgreSQL connection string',
    }),

  /**
   * Shared secret used by machine callers (GitHub Actions cron in Phase 2).
   * Optional in Phase 1 so local development needs no setup; the auth
   * middleware that consumes it is introduced alongside the cron trigger.
   */
  AUTOMATION_API_KEY: z.string().min(16).optional(),

  /** Hard ceiling on a single automation run, enforced by the service. */
  EXECUTION_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  /** Seconds a client must wait out after exhausting the API rate limit. */
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(60),
});

export type Env = Readonly<z.infer<typeof envSchema>>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const report = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    // The logger depends on env, so this one case legitimately predates it.
    process.stderr.write(`\n[autopilot] Invalid environment configuration:\n${report}\n\n`);
    process.exit(1);
  }

  return Object.freeze(parsed.data);
}

export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';

/** Parsed CORS origins: `true` means "reflect any origin". */
export const corsOrigins: true | string[] =
  env.CORS_ORIGINS.trim() === '*'
    ? true
    : env.CORS_ORIGINS.split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0);
