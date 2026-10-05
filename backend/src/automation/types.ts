import type { Logger } from '../config/logger';

/**
 * The automation domain contract.
 *
 * This is the seam that keeps AutoPilot from becoming "a Naukri app". Everything
 * above it (controller, service) and below it (workers) speaks only in these
 * terms. Nothing outside `workers/` may name a specific provider.
 */

/**
 * Every provider AutoPilot knows about, including unimplemented ones. Kept
 * separate from the registry on purpose: this is the domain, the registry is
 * reality. An ID here but absent from the registry yields a clean 400.
 */
export const PROVIDER_IDS = ['naukri', 'linkedin', 'github', 'indeed', 'resume_upload'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * What a worker is being asked to do. Namespaced (`domain.verb`) so one worker can
 * serve several behaviours without a class explosion.
 */
export const AUTOMATION_ACTIONS = ['profile.update'] as const;
export type AutomationAction = (typeof AUTOMATION_ACTIONS)[number];

/**
 * Which of the user's accounts on a provider a run targets. One person can hold
 * several (e.g. two Naukri profiles); each has its own session and its own lock.
 * Requests that name no account get `default`, so single-account callers are
 * unaffected.
 */
export const DEFAULT_ACCOUNT = 'default';
export const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Who asked for this run. Cron runs are worth distinguishing in history. */
export const TRIGGER_SOURCES = ['API', 'CRON', 'MANUAL'] as const;
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];

/**
 * Everything a worker gets for one run.
 *
 * The logger is passed in rather than imported so the service can pre-stamp it
 * with executionId and provider — that is the whole correlation story.
 *
 * `signal` is aborted when the time budget expires, so a hung API call
 * releases its resources instead of hanging forever.
 */
export interface ExecutionContext {
  readonly executionId: string;
  readonly provider: ProviderId;
  readonly account: string;
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
 * Return `success: false` for an expected, describable failure ("headline already
 * current, nothing to submit"). **Throw** for genuine breakage — failed login,
 * missing selector. The service classifies both; workers never build responses.
 */
export interface WorkerOutcome {
  readonly success: boolean;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export interface AutomationWorker {
  readonly provider: ProviderId;
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
  readonly account: string;
  readonly action: AutomationAction;
  readonly trigger: TriggerSource;
  readonly dryRun: boolean;
}

/** The service's result, returned to clients as-is. */
export interface ExecutionResult {
  readonly executionId: string;
  readonly provider: ProviderId;
  readonly account: string;
  readonly action: AutomationAction;
  readonly trigger: TriggerSource;
  readonly status: 'SUCCESS' | 'FAILED';
  readonly message: string;
  readonly durationMs: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly details?: Record<string, unknown>;
}
