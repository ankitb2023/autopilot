import { randomUUID } from 'node:crypto';

import { env } from '../config/env';
import { logger } from '../config/logger';
import {
  AppError,
  AutomationFailedError,
  AutomationTimeoutError,
  ExecutionLockedError,
  toError,
} from '../core/errors';
import { acquireExecutionLock, buildLockKey, releaseExecutionLock } from './execution.lock';
import { createWorker } from './provider.registry';
import type { ExecutionContext, ExecutionRequest, ExecutionResult } from './types';

/**
 * The automation engine.
 *
 * Owns everything identical across providers, so workers stay small and
 * interchangeable: execution IDs, the single-flight lock, the time budget,
 * timing, logging, and failure classification.
 *
 * Phase 4 adds history persistence at the marked seams — a service change only,
 * no worker touched.
 */
export async function executeAutomation(request: ExecutionRequest): Promise<ExecutionResult> {
  const executionId = randomUUID();

  // Child logger = the whole correlation story. Every line from here down,
  // including the worker's, carries these fields.
  const runLogger = logger.child({
    executionId,
    provider: request.provider,
    action: request.action,
    trigger: request.trigger,
  });

  /*
   * Single-flight gate, acquired *before* the try/finally below on purpose: a
   * rejected run never started, so it must not be logged as a failure and must not
   * create an ExecutionHistory row in Phase 4. A 409 is a normal outcome for an
   * overlapping cron tick, not an error.
   */
  const lockKey = buildLockKey(request);
  const lock = await acquireExecutionLock(
    lockKey,
    executionId,
    request.trigger,
    env.EXECUTION_TIMEOUT_MS,
  );

  if (!lock.acquired) {
    const retryAfterSeconds = lock.heldBy
      ? Math.max(1, Math.ceil((lock.heldBy.expiresAt.getTime() - Date.now()) / 1000))
      : Math.ceil(env.EXECUTION_TIMEOUT_MS / 1000);

    runLogger.warn('execution rejected: another run holds the lock', {
      lockKey,
      heldByExecutionId: lock.heldBy?.executionId,
    });

    throw new ExecutionLockedError(lockKey, retryAfterSeconds, lock.heldBy?.executionId);
  }

  // Clock starts only once we hold the lock, so duration measures the automation
  // rather than time spent contending.
  const startedAt = new Date();
  const startedAtMs = performance.now();

  runLogger.info('execution started', { dryRun: request.dryRun });

  // Phase 4 seam: insert an ExecutionHistory row with status RUNNING.

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.EXECUTION_TIMEOUT_MS);
  timeout.unref(); // Don't hold the event loop open for a pending timeout.

  try {
    const worker = createWorker(request.provider);

    if (!worker.supportedActions.includes(request.action)) {
      throw new AutomationFailedError(
        `Provider "${request.provider}" does not support action "${request.action}".`,
        { supportedActions: worker.supportedActions },
      );
    }

    const context: ExecutionContext = {
      executionId,
      provider: request.provider,
      action: request.action,
      trigger: request.trigger,
      dryRun: request.dryRun,
      logger: runLogger,
      signal: controller.signal,
    };

    const outcome = await worker.execute(context);
    const durationMs = Math.round(performance.now() - startedAtMs);

    // Phase 4 seam: update the row to its terminal status.
    // Phase 5 seam: dispatch the notification.

    runLogger.info('execution finished', { success: outcome.success, durationMs });

    return {
      executionId,
      provider: request.provider,
      action: request.action,
      trigger: request.trigger,
      status: outcome.success ? 'SUCCESS' : 'FAILED',
      message: outcome.message,
      durationMs,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      ...(outcome.details ? { details: outcome.details } : {}),
    };
  } catch (error) {
    // Phase 4 seam: update the row to FAILED with the code and message.

    runLogger.error('execution failed', {
      durationMs: Math.round(performance.now() - startedAtMs),
      error: toError(error).message,
      stack: toError(error).stack,
    });

    // The abort fires as a plain AbortError inside the worker; report the cause.
    if (controller.signal.aborted) throw new AutomationTimeoutError(env.EXECUTION_TIMEOUT_MS);
    // A worker that knows why it failed should be believed.
    if (error instanceof AppError) throw error;
    // Anything else: from the caller's view, driving the provider broke.
    throw new AutomationFailedError('Automation run failed unexpectedly.');
  } finally {
    clearTimeout(timeout);
    // Always release. This never throws, so it cannot mask the run's outcome.
    await releaseExecutionLock(lockKey, executionId);
  }
}
