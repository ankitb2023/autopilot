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
 * Deliberately contains no Playwright, no credentials handling and no selectors.
 * Its job right now is to prove the pipeline end to end:
 *
 *   controller → service → registry → worker → response
 *
 * Phase 3 replaces the body of `execute()` only. The class shape, its place in
 * the registry, and every layer above it stay untouched — which is the whole
 * point of the interface.
 */
export class NaukriWorker implements AutomationWorker {
  readonly provider: ProviderId = 'naukri';
  readonly supportedActions: readonly AutomationAction[] = ['profile.update'];

  async execute(context: ExecutionContext): Promise<WorkerOutcome> {
    const { logger, dryRun, signal } = context;

    logger.info('naukri worker starting', { dryRun });

    // Cooperative cancellation: Phase 3 will check this between browser steps.
    // Honouring it even in the stub keeps the contract honest.
    signal.throwIfAborted();

    logger.info('naukri worker finished');

    return {
      success: true,
      message: 'Naukri worker executed.',
      details: { stub: true, dryRun },
    };
  }
}
