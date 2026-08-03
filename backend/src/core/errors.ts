/**
 * Error model.
 *
 * Anything crossing the HTTP boundary is either an `AppError` — expected,
 * classified, safe to show — or an unknown throwable, treated as a bug and
 * reported as a generic 500. Stack traces are logged, never sent to the client.
 *
 * `code` is a stable string. Callers (the cron workflow, later the dashboard)
 * branch on `code`, never on `message`.
 */
export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, 404, 'NOT_FOUND');
  }
}

export class ProviderNotSupportedError extends AppError {
  constructor(provider: string, supported: readonly string[]) {
    super(`Provider "${provider}" is not supported.`, 400, 'PROVIDER_NOT_SUPPORTED', {
      supported,
    });
  }
}

/** Another run holds this provider's lock. 409 = conflict with current state. */
export class ExecutionLockedError extends AppError {
  constructor(
    lockKey: string,
    readonly retryAfterSeconds: number,
    heldByExecutionId?: string,
  ) {
    super(`An automation for "${lockKey}" is already running.`, 409, 'EXECUTION_IN_PROGRESS', {
      lockKey,
      heldByExecutionId,
    });
  }
}

/** The provider was reached but driving it failed. 502: upstream, not us. */
export class AutomationFailedError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 502, 'AUTOMATION_FAILED', details);
  }
}

export class AutomationTimeoutError extends AppError {
  constructor(timeoutMs: number) {
    super(`Automation exceeded its ${timeoutMs}ms budget.`, 504, 'AUTOMATION_TIMEOUT');
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message: string) {
    super(message, 503, 'SERVICE_UNAVAILABLE');
  }
}

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
