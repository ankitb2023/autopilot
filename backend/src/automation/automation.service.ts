import { randomUUID } from 'node:crypto';

import { env } from '../config/env';
import { createChildLogger } from '../config/logger';
import { setContextValues } from '../core/context';
import { AutomationFailedError, AutomationTimeoutError, isAppError, toError } from '../core/errors';
import { createWorker } from './provider.registry';
import type { ExecutionContext, ExecutionRequest, ExecutionResult, WorkerOutcome } from './types';

/**
 * The automation engine.
 *
 * Owns every concern that is identical for all providers, so that workers stay
 * small and interchangeable:
 *
 *   - minting the execution ID and binding it to the log context
 *   - enforcing the execution time budget via AbortSignal
 *   - measuring duration
 *   - verifying the worker actually supports the requested action
 *   - classifying failures into the error model
 *
 * Phase 4 adds persistence at the two marked seams (start → PENDING/RUNNING row,
 * end → terminal update). It is a service change only; no worker is affected.
 */
export class AutomationService {
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const executionId = randomUUID();
    const startedAt = new Date();
    const startedAtMs = performance.now();

    // Bind the execution to the ambient context so every downstream log line —
    // including Prisma's and the worker's — is correlated.
    setContextValues({ executionId });

    const logger = createChildLogger({
      provider: request.provider,
      action: request.action,
      trigger: request.trigger,
    });

    logger.info('automation execution started', { executionId, dryRun: request.dryRun });

    // Phase 4 seam: persist an ExecutionHistory row with status RUNNING here.

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new AutomationTimeoutError(env.EXECUTION_TIMEOUT_MS, { executionId }));
    }, env.EXECUTION_TIMEOUT_MS);
    // Do not hold the event loop open purely for a pending timeout.
    timeout.unref();

    try {
      const worker = createWorker(request.provider);

      if (!worker.supportedActions.includes(request.action)) {
        throw new AutomationFailedError(
          `Provider "${request.provider}" does not support action "${request.action}".`,
          {
            provider: request.provider,
            action: request.action,
            supportedActions: worker.supportedActions,
          },
        );
      }

      const context: ExecutionContext = {
        executionId,
        provider: request.provider,
        action: request.action,
        trigger: request.trigger,
        dryRun: request.dryRun,
        logger,
        signal: controller.signal,
      };

      const outcome = await worker.execute(context);

      const result = this.buildResult(request, executionId, startedAt, startedAtMs, outcome);

      // Phase 4 seam: update the row to its terminal status.
      // Phase 5 seam: dispatch the notification from here.

      logger.info('automation execution finished', {
        executionId,
        status: result.status,
        durationMs: result.durationMs,
      });

      return result;
    } catch (error) {
      const durationMs = Math.round(performance.now() - startedAtMs);

      // Phase 4 seam: update the row to FAILED, recording code and message.

      logger.error('automation execution failed', {
        executionId,
        durationMs,
        error: toError(error).message,
        stack: toError(error).stack,
      });

      throw this.classifyFailure(error, executionId, controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildResult(
    request: ExecutionRequest,
    executionId: string,
    startedAt: Date,
    startedAtMs: number,
    outcome: WorkerOutcome,
  ): ExecutionResult {
    const durationMs = Math.round(performance.now() - startedAtMs);

    return {
      executionId,
      provider: request.provider,
      action: request.action,
      trigger: request.trigger,
      status: outcome.success ? 'SUCCESS' : 'FAILED',
      success: outcome.success,
      message: outcome.message,
      durationMs,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      ...(outcome.details ? { details: outcome.details } : {}),
    };
  }

  /**
   * Maps anything a worker threw onto the error model.
   *
   * An already-classified `AppError` passes through untouched — a worker that
   * knows *why* it failed should be believed. Everything else becomes a 502:
   * from the caller's perspective, driving the upstream provider broke.
   */
  private classifyFailure(error: unknown, executionId: string, signal: AbortSignal): Error {
    if (signal.aborted && signal.reason instanceof AutomationTimeoutError) {
      return signal.reason;
    }

    if (isAppError(error)) {
      return error;
    }

    const cause = toError(error);
    return new AutomationFailedError('Automation run failed unexpectedly.', { executionId }, cause);
  }
}

/**
 * Single shared instance. The service is stateless, so one instance is enough
 * and this keeps wiring honest without dragging in a DI container we do not need.
 */
export const automationService = new AutomationService();
