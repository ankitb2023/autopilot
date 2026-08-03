/**
 * Error model.
 *
 * Every error crossing the HTTP boundary is either an `AppError` — expected,
 * classified, safe to describe to the caller — or an unknown throwable, which is
 * treated as a bug: logged with its stack, reported to the client as a generic
 * 500. Stack traces never leave the process.
 *
 * `code` is a stable machine-readable string. Clients (dashboard, mobile app,
 * GitHub Actions) branch on `code`, never on `message`, so wording stays free to
 * change without breaking consumers.
 */

export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  PROVIDER_NOT_SUPPORTED: 'PROVIDER_NOT_SUPPORTED',
  AUTOMATION_FAILED: 'AUTOMATION_FAILED',
  AUTOMATION_TIMEOUT: 'AUTOMATION_TIMEOUT',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Structured, client-safe supplementary information. */
export type ErrorDetails = Record<string, unknown> | unknown[];

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: ErrorDetails;

  /**
   * `true` for errors we anticipated (bad input, provider failure). `false`
   * marks a programming defect — the handler logs those at `error` level with
   * the full stack, and they are the ones worth alerting on.
   */
  readonly isOperational: boolean;

  constructor(
    message: string,
    options: {
      statusCode: number;
      code: ErrorCode;
      details?: ErrorDetails;
      isOperational?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.details = options.details;
    this.isOperational = options.isOperational ?? true;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Request validation failed', details?: ErrorDetails) {
    super(message, { statusCode: 400, code: ErrorCode.VALIDATION_FAILED, details });
  }
}

export class ProviderNotSupportedError extends AppError {
  constructor(provider: string, supportedProviders: readonly string[]) {
    super(`Automation provider "${provider}" is not supported.`, {
      statusCode: 400,
      code: ErrorCode.PROVIDER_NOT_SUPPORTED,
      details: { provider, supportedProviders },
    });
  }
}

/**
 * The provider was reached but the automation itself did not succeed.
 *
 * 502 rather than 500: the failure originated in an upstream system we merely
 * drive. That distinction matters when reading Render's error-rate graphs.
 */
export class AutomationFailedError extends AppError {
  constructor(message: string, details?: ErrorDetails, cause?: unknown) {
    super(message, {
      statusCode: 502,
      code: ErrorCode.AUTOMATION_FAILED,
      details,
      cause,
    });
  }
}

export class AutomationTimeoutError extends AppError {
  constructor(timeoutMs: number, details?: ErrorDetails) {
    super(`Automation exceeded its ${timeoutMs}ms time budget.`, {
      statusCode: 504,
      code: ErrorCode.AUTOMATION_TIMEOUT,
      details,
    });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required.') {
    super(message, { statusCode: 401, code: ErrorCode.UNAUTHORIZED });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found.', details?: ErrorDetails) {
    super(message, { statusCode: 404, code: ErrorCode.NOT_FOUND, details });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable.', details?: ErrorDetails) {
    super(message, { statusCode: 503, code: ErrorCode.SERVICE_UNAVAILABLE, details });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Normalises anything throwable into an `Error` for logging purposes. */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : JSON.stringify(value));
}
