import type {
  AutomationAction,
  AutomationWorker,
  ExecutionContext,
  ProviderId,
  WorkerOutcome,
} from '../types';

/**
 * Naukri automation worker — Phase 1 stub.
 *
 * No Playwright, no credentials, no selectors yet. Its job is to prove the
 * pipeline end to end: controller → service → lock → registry → worker.
 *
 * Phase 3 replaces the body of `execute()` only. The class shape, its registry
 * entry, and every layer above it stay untouched — the point of the interface.
 */
export class NaukriWorker implements AutomationWorker {
  readonly provider: ProviderId = 'naukri';
  readonly supportedActions: readonly AutomationAction[] = ['profile.update'];

  async execute({ logger, dryRun, signal }: ExecutionContext): Promise<WorkerOutcome> {
    logger.info('naukri worker starting', { dryRun });

    // Cooperative cancellation: Phase 3 checks this between browser steps.
    // Honouring it in the stub keeps the contract honest.
    signal.throwIfAborted();

    return {
      success: true,
      message: 'Naukri worker executed.',
      details: { stub: true, dryRun },
    };
  }
}
