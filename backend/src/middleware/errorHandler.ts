import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';

import { logger } from '../config/logger';
import { isProduction } from '../config/env';
import { ErrorCode, NotFoundError, isAppError, toError } from '../core/errors';
import { sendError } from '../core/httpResponse';

/**
 * Terminal 404 handler.
 *
 * Registered after all routes; converts "no route matched" into the same error
 * shape as everything else, so clients have exactly one error format to parse.
 */
export function notFoundHandler(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    next(new NotFoundError(`Route ${req.method} ${req.originalUrl} does not exist.`));
  };
}

/**
 * Centralized error handler — the single place an error becomes a response.
 *
 * Guarantees:
 *   - Stack traces are logged, never serialised to the client.
 *   - Operational errors (bad input, provider failure) log at warn; unexpected
 *     ones log at error with the full stack. That split is what makes alerting
 *     on `level=error` meaningful instead of noisy.
 *   - Unknown errors always become a generic 500. We never echo an internal
 *     message, since it may contain connection strings or selector internals.
 *   - Headers-already-sent is delegated to Express, which destroys the socket;
 *     writing a second response would corrupt the stream.
 */
export function errorHandler(): ErrorRequestHandler {
  return (error: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const normalised = toError(error);

    if (isAppError(error)) {
      const logMeta = {
        code: error.code,
        statusCode: error.statusCode,
        details: error.details,
      };

      if (error.isOperational && error.statusCode < 500) {
        logger.warn(error.message, logMeta);
      } else {
        logger.error(error.message, { ...logMeta, stack: error.stack, cause: error.cause });
      }

      sendError(res, error.statusCode, error.code, error.message, error.details);
      return;
    }

    // Unclassified: treat as a defect. Log everything, reveal nothing.
    logger.error('unhandled error', {
      message: normalised.message,
      stack: normalised.stack,
    });

    sendError(
      res,
      500,
      ErrorCode.INTERNAL_ERROR,
      'An unexpected error occurred.',
      // In development, surface the real message to keep the loop fast.
      isProduction ? undefined : { message: normalised.message },
    );
  };
}
