import { logger } from '../config/logger';
import { prisma } from '../config/prisma';
import { ServiceUnavailableError, toError } from '../core/errors';
import type { ExecutionRequest, ProviderId, TriggerSource } from './types';

/**
 * Execution mutual exclusion.
 *
 * Without this, a cron tick firing while the previous run is still going — or a
 * manual retry during a scheduled run — starts a second automation. This means
 * two parallel API calls logging into the same account at once, which
 * is a plausible way to get the account flagged.
 *
 * A TTL lease row acquired with one atomic upsert. Not a Postgres advisory lock:
 * session-scoped advisory locks are bound to a connection and Prisma pools
 * connections, so the unlock can land on a different connection and silently leak.
 * The transaction-scoped variant avoids that only by holding a transaction open for
 * the entire run — minutes of `idle in transaction` if an API call hangs.
 *
 * This gives us: atomicity, self-healing after a crash (TTL), correctness through
 * a connection pooler, and an inspectable holder (`SELECT * FROM automation_locks`).
 */

/**
 * Added on top of the execution budget. The service aborts a run at
 * EXECUTION_TIMEOUT_MS, so a lease of timeout + grace always outlives the run it
 * guards; the grace covers process death between abort and release.
 */
const LOCK_GRACE_MS = 30_000;

/**
 * Lock key: **provider only**, deliberately ignoring the action.
 *
 * The contended resource is the remote account/session, and that is per-provider.
 * Keying on `provider:action` would still let `naukri:profile.update` and a future
 * `naukri:resume.upload` drive two simultaneous logins into the same account —
 * exactly what this prevents. One function, one place to change.
 */
export function buildLockKey(request: Pick<ExecutionRequest, 'provider'>): ProviderId {
  return request.provider;
}

export type LockAcquisition =
  | { acquired: true; expiresAt: Date }
  | { acquired: false; heldBy?: { executionId: string; expiresAt: Date } };

/**
 * Attempts to take the lock.
 *
 * `WHERE expiresAt <= now()` is what makes this safe: on conflict the row is only
 * taken over if the existing lease has already expired. A live lease makes the
 * statement affect zero rows, which reads as "not acquired" — no exception, no
 * race. Timestamps use the *database* clock, so app clock skew cannot hand the
 * lock to two runs.
 *
 * Throws if the lock cannot be evaluated at all. Failing closed is deliberate:
 * better to refuse a run than perform one without a guarantee of exclusivity.
 */
export async function acquireExecutionLock(
  key: string,
  executionId: string,
  trigger: TriggerSource,
  ttlMs: number,
): Promise<LockAcquisition> {
  const ttlSeconds = Math.ceil((ttlMs + LOCK_GRACE_MS) / 1000);

  let rows: Array<{ expiresAt: Date }>;
  try {
    rows = await prisma.$queryRaw<Array<{ expiresAt: Date }>>`
      INSERT INTO "automation_locks" ("key", "executionId", "trigger", "acquiredAt", "expiresAt")
      VALUES (
        ${key},
        ${executionId}::uuid,
        ${trigger}::"TriggerSource",
        now(),
        now() + make_interval(secs => ${ttlSeconds}::double precision)
      )
      ON CONFLICT ("key") DO UPDATE
        SET "executionId" = EXCLUDED."executionId",
            "trigger"     = EXCLUDED."trigger",
            "acquiredAt"  = EXCLUDED."acquiredAt",
            "expiresAt"   = EXCLUDED."expiresAt"
        WHERE "automation_locks"."expiresAt" <= now()
      RETURNING "expiresAt"
    `;
  } catch (error) {
    logger.error('failed to evaluate execution lock', { key, error: toError(error).message });
    throw new ServiceUnavailableError(
      'Unable to verify that no other automation is running. Refusing to start.',
    );
  }

  const acquired = rows[0];
  if (acquired) {
    return { acquired: true, expiresAt: acquired.expiresAt };
  }

  // Best-effort diagnostics for the 409; the holder may already have released.
  return { acquired: false, heldBy: await readLockHolder(key) };
}

/**
 * Releases the lock, but only if this execution still owns it.
 *
 * The executionId predicate matters: if our lease had expired and a later run took
 * the key over, deleting by key alone would strip that run's lock and allow exactly
 * the concurrency this module prevents.
 *
 * Never throws — the run has already finished, and the TTL is a sufficient backstop.
 * Turning a cleanup failure into a request failure would misreport a good run.
 */
export async function releaseExecutionLock(key: string, executionId: string): Promise<void> {
  try {
    const deleted = await prisma.$executeRaw`
      DELETE FROM "automation_locks"
      WHERE "key" = ${key} AND "executionId" = ${executionId}::uuid
    `;
    if (deleted === 0) {
      // Means the run overran its lease and someone else now holds the key.
      logger.warn('execution lock was not held at release time', { key, executionId });
    }
  } catch (error) {
    logger.error('failed to release execution lock; relying on lease expiry', {
      key,
      error: toError(error).message,
    });
  }
}

async function readLockHolder(
  key: string,
): Promise<{ executionId: string; expiresAt: Date } | undefined> {
  try {
    const rows = await prisma.$queryRaw<Array<{ executionId: string; expiresAt: Date }>>`
      SELECT "executionId", "expiresAt" FROM "automation_locks" WHERE "key" = ${key}
    `;
    return rows[0];
  } catch {
    return undefined;
  }
}
