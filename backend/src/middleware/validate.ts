import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';

import { ValidationError } from '../core/errors';

interface ValidationSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/**
 * Flattens Zod issues into a client-safe, stable shape.
 *
 * Zod's raw error object leaks internals we do not want in an API contract, so we
 * project it down to `{ field, message, code }`.
 */
function formatIssues(error: ZodError): Array<{ field: string; message: string; code: string }> {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * Validates and *replaces* the named request parts with their parsed values.
 *
 * Replacement matters: after this middleware, `req.body` holds coerced,
 * defaulted, trusted data. Controllers never re-check and never see raw input,
 * which removes the entire class of "validated one shape, used another" bugs.
 */
export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      // `ZodTypeAny.parse` is typed `any`; narrowing to `unknown` first keeps the
      // assignment honest — the real type is recovered at the call site via
      // `validatedBody`, where the concrete schema is known.
      if (schemas.body) req.body = schemas.body.parse(req.body) as unknown;
      if (schemas.query) req.query = schemas.query.parse(req.query) as Request['query'];
      if (schemas.params) req.params = schemas.params.parse(req.params) as Request['params'];
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        next(new ValidationError('Request validation failed', formatIssues(error)));
        return;
      }
      next(error);
    }
  };
}

/**
 * Reads a validated body with its inferred type.
 *
 * Express types `req.body` as `any`; this restores type safety at the one point
 * where the controller consumes it, without a global type augmentation that would
 * lie for un-validated routes.
 */
export function validatedBody<S extends ZodTypeAny>(req: Request, _schema: S): z.infer<S> {
  return req.body as z.infer<S>;
}
