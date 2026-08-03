import dotenv from 'dotenv';
import { z } from 'zod';

/**
 * Environment configuration — validated once at boot, so a missing DATABASE_URL
 * fails on startup rather than at 3am during a scheduled run.
 *
 * One `.env` file, loaded locally. On Render the platform injects these and
 * dotenv is a no-op.
 */
dotenv.config();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  /**
   * Shared secret for the GitHub Actions cron trigger (Phase 2).
   * Optional so local development needs no setup.
   */
  AUTOMATION_API_KEY: z.string().min(16).optional(),

  /** Hard ceiling on one automation run. Raise in Phase 3 — Playwright is slower. */
  EXECUTION_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  /** 
   * JSON string of session cookies for Naukri (legacy, not used in API mode).
   */
  NAUKRI_COOKIES: z.string().optional(),

  /** Login credentials for Naukri API authentication */
  NAUKRI_EMAIL: z.string().optional(),
  NAUKRI_PASSWORD: z.string().optional(),

  /** Profile hash ID — get from browser Network tab when saving profile */
  NAUKRI_PROFILE_ID: z.string().optional(),

  /** Comma-separated key skills string to re-save */
  NAUKRI_KEY_SKILLS: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const report = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  // The logger depends on env, so this one case legitimately predates it.
  process.stderr.write(`\n[autopilot] Invalid environment:\n${report}\n\n`);
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
