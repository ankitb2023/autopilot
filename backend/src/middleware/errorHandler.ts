import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

import { isProduction } from '../config/env';
import { logger } from '../config/logger';
import { AppError, ExecutionLockedError, NotFoundError, toError } from '../core/errors';

/** Turns "no route matched" into the same error shape as everything else. */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.originalUrl} does not exist.`));
};

/**
 * Centralized error handler — the single place an error becomes a response.
 *
 * Client errors log at warn, server errors at error with a stack, so alerting on
 * `level=error` stays meaningful. Unknown errors always become a generic 500:
 * their messages can leak connection strings or selector internals.
 */
export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (res.headersSent) {
    // Express destroys the socket; writing a second response would corrupt it.
    next(error);
    return;
  }

  // Zod throws from controllers that parse their own input.
  if (error instanceof ZodError) {
    const details = error.issues.map((issue) => ({
      field: issue.path.join('.') || '(root)',
      message: issue.message,
    }));
    logger.warn('request validation failed', { details });
    res.status(400).json({ code: 'VALIDATION_FAILED', message: 'Invalid request.', details });
    return;
  }

  if (error instanceof AppError) {
    if (error.statusCode >= 500) {
      logger.error(error.message, { code: error.code, stack: error.stack });
    } else {
      logger.warn(error.message, { code: error.code, details: error.details });
    }

    // Lets the cron workflow back off correctly instead of hammering a locked run.
    if (error instanceof ExecutionLockedError) {
      res.setHeader('Retry-After', String(error.retryAfterSeconds));
    }

    res.status(error.statusCode).json({
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    });
    return;
  }

  const normalised = toError(error);
  logger.error('unhandled error', { message: normalised.message, stack: normalised.stack });

  res.status(500).json({
    code: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred.',
    // Surface the real message in development to keep the loop fast.
    ...(isProduction ? {} : { details: normalised.message }),
  });
};
