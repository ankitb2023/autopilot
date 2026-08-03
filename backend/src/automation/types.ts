import type { Logger } from '../config/logger';

/**
 * The automation domain contract.
 *
 * This file is the seam that keeps AutoPilot from becoming "a Naukri app". Every
 * layer above it (controller, service) and below it (workers) speaks only in
 * these terms. Nothing outside `workers/` may mention a specific provider.
 */

/**
 * The full vocabulary of providers AutoPilot knows about — including ones not
 * yet implemented. Kept separate from the registry on purpose: this is the
 * *domain*, the registry is *reality*. An ID listed here but absent from the
 * registry yields a clean 400 naming what is actually available.
 */
export const PROVIDER_IDS = ['naukri', 'linkedin', 'github', 'indeed', 'resume_upload'] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * What a worker is being asked to do.
 *
 * Actions are namespaced (`domain.verb`) so one worker can serve several
 * behaviours without a class explosion — Phase 3's Naukri worker will handle
 * both `profile.update` and, later, `resume.upload`.
 */
export const AUTOMATION_ACTIONS = ['profile.update'] as const;

export type AutomationAction = (typeof AUTOMATION_ACTIONS)[number];

/** Who asked for this run. Drives history filtering and alerting policy. */
export const TRIGGER_SOURCES = ['API', 'CRON', 'MANUAL'] as const;

export type TriggerSource = (typeof TRIGGER_SOURCES)[number];

/**
 * Everything a worker is handed for one run.
 *
 * Workers receive their logger rather than importing one, so the service can
 * pre-stamp provider/action/executionId — and so Phase 9 can swap in a logger
 * that also streams to a WebSocket without touching a single worker.
 *
 * `signal` is honoured by workers for cooperative cancellation; the service
 * aborts it when the execution time budget expires so a hung Playwright session
 * (Phase 3) releases its browser instead of leaking it.
 */
export interface ExecutionContext {
  readonly executionId: string;
  readonly provider: ProviderId;
  readonly action: AutomationAction;
  readonly trigger: TriggerSource;
  /** When true, the worker performs read-only steps and mutates nothing. */
  readonly dryRun: boolean;
  readonly logger: Logger;
  readonly signal: AbortSignal;
}

/**
 * What a worker reports back.
 *
 * A worker returns `success: false` for an expected, meaningful failure it can
 * describe (e.g. "profile headline unchanged, nothing to submit"). It *throws*
 * for genuine breakage — a failed login, a missing selector. The service
 * classifies both; workers never build HTTP responses.
 */
export interface WorkerOutcome {
  readonly success: boolean;
  readonly message: string;
  /** Provider-specific structured payload, persisted as JSON in Phase 4. */
  readonly details?: Record<string, unknown>;
}

export interface AutomationWorker {
  readonly provider: ProviderId;
  /** Actions this worker can service. Checked before it is invoked. */
  readonly supportedActions: readonly AutomationAction[];

  execute(context: ExecutionContext): Promise<WorkerOutcome>;
}

/**
 * Lazy constructor. Phase 3 workers own browser contexts; instantiating every
 * registered worker at boot would launch browsers we never use.
 */
export type WorkerFactory = () => AutomationWorker;

/** The request the service acts on, independent of transport. */
export interface ExecutionRequest {
  readonly provider: ProviderId;
  readonly action: AutomationAction;
  readonly trigger: TriggerSource;
  readonly dryRun: boolean;
}

/** The service's result, and the shape the controller returns to clients. */
export interface ExecutionResult {
  readonly executionId: string;
  readonly provider: ProviderId;
  readonly action: AutomationAction;
  readonly trigger: TriggerSource;
  readonly status: 'SUCCESS' | 'FAILED';
  readonly success: boolean;
  readonly message: string;
  readonly durationMs: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly details?: Record<string, unknown>;
}
