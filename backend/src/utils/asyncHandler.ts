import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Forwards rejected promises from async handlers to Express's error pipeline.
 *
 * Express 4 does not await handlers, so a thrown async error becomes an
 * unhandled rejection and the request hangs until the client times out. Wrapping
 * every async handler is the standard fix.
 *
 * Express 5 handles this natively; when we upgrade, this file is deleted and the
 * wrappers come off. Kept as an explicit util rather than a patched Router so the
 * behaviour is visible at the call site.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
