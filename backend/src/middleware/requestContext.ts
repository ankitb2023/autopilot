import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { runWithContext } from '../core/context';

const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Establishes the correlation context for the request.
 *
 * An inbound `x-request-id` is honoured so a trace started by GitHub Actions, a
 * load balancer, or the dashboard survives the hop into this service; otherwise
 * we mint one. The ID is echoed back as a response header *and* inside the
 * envelope's `meta`, because header access differs across our future clients.
 *
 * Inbound IDs are length-capped and character-filtered: header values are
 * attacker-controlled and this one ends up in log lines and response headers.
 */
export function requestContext(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const inbound = req.header(REQUEST_ID_HEADER);
    const requestId = sanitiseRequestId(inbound) ?? randomUUID();

    res.setHeader(REQUEST_ID_HEADER, requestId);

    runWithContext({ requestId }, () => {
      next();
    });
  };
}

function sanitiseRequestId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().slice(0, 128);
  return /^[A-Za-z0-9._:-]+$/.test(trimmed) ? trimmed : undefined;
}
