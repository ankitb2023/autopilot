import rateLimit from 'express-rate-limit';
import type { RequestHandler } from 'express';

import { env } from '../config/env';
import { ErrorCode } from '../core/errors';
import { sendError } from '../core/httpResponse';

/**
 * Rate limiting for the automation API.
 *
 * Applied to `/api` only — health probes are polled aggressively by the platform
 * and must never be throttled.
 *
 * The store is in-memory, which is correct for a single Render instance. If we
 * ever scale horizontally the limit becomes per-instance; at that point this
 * swaps to a Redis store. Documented here so the limitation is a known decision
 * rather than a surprise.
 *
 * The custom handler exists so a 429 uses the same envelope as every other error.
 */
export function apiRateLimiter(): RequestHandler {
  return rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_SECONDS * 1000,
    limit: env.RATE_LIMIT_MAX_REQUESTS,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => {
      sendError(res, 429, ErrorCode.RATE_LIMITED, 'Too many requests. Please retry later.');
    },
  });
}
