import type { Response } from 'express';

import { getContext } from './context';
import type { ErrorCode, ErrorDetails } from './errors';

/**
 * A single response envelope for the whole API.
 *
 * Discriminated on `success`, so a TypeScript client (dashboard, React Native
 * app) narrows the payload with one check. `meta.requestId` is echoed on every
 * response — it is the string a user pastes into a bug report, and the string we
 * grep the logs for.
 */
export interface ResponseMeta {
  requestId: string;
  timestamp: string;
}

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
  meta: ResponseMeta;
}

export interface ErrorEnvelope {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: ErrorDetails;
  };
  meta: ResponseMeta;
}

export type ApiEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

function buildMeta(): ResponseMeta {
  return {
    requestId: getContext()?.requestId ?? 'unknown',
    timestamp: new Date().toISOString(),
  };
}

export function sendSuccess<T>(res: Response, data: T, statusCode = 200): void {
  const body: SuccessEnvelope<T> = { success: true, data, meta: buildMeta() };
  res.status(statusCode).json(body);
}

export function sendError(
  res: Response,
  statusCode: number,
  code: ErrorCode,
  message: string,
  details?: ErrorDetails,
): void {
  const body: ErrorEnvelope = {
    success: false,
    error: details === undefined ? { code, message } : { code, message, details },
    meta: buildMeta(),
  };
  res.status(statusCode).json(body);
}
