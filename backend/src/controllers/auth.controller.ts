import type { Request, Response } from 'express';
import { z } from 'zod';

import { clearCookieJar, cookieNames, loadCookieJar } from '../automation/naukri/cookies';
import {
  attemptLogin,
  getAccessToken,
  readJwtExpiry,
  refreshAccessToken,
  storeAccessToken,
} from '../automation/naukri/naukri.auth';
import { logger } from '../config/logger';
import { prisma } from '../config/prisma';
import { AppError } from '../core/errors';

/**
 * Naukri authentication endpoints.
 *
 * These exist for the one thing that cannot be automated: supplying an OTP. The goal
 * is to need them **once**. Every login here captures Naukri's full cookie jar, so a
 * later unattended re-login can present itself as the same known device.
 */

/**
 * POST /api/auth/init-login
 *
 * Tries a password-only login. If Naukri accepts it, we're done and no OTP was needed
 * — which is also the test for whether the device is now trusted.
 */
export async function initLogin(_req: Request, res: Response): Promise<void> {
  const attempt = await attemptLogin(logger);

  if (attempt.mfaRequired) {
    res.status(200).json({
      status: 'MFA_REQUIRED',
      message: 'OTP sent to your registered email. Post it to /api/auth/verify-otp.',
      flowId: attempt.flowId,
      email: attempt.email,
    });
    return;
  }

  if (attempt.accessToken) {
    res.json({
      status: 'LOGIN_SUCCESS',
      message: 'Logged in without OTP — this device is trusted. Automation can self-renew.',
      expiresAt: attempt.expiresAt?.toISOString(),
    });
    return;
  }

  res.status(502).json({
    status: 'LOGIN_FAILED',
    message: `Naukri returned HTTP ${attempt.status} without a token.`,
    naukriResponse: attempt.body,
  });
}

const verifyOtpSchema = z.object({
  otp: z.string().min(4).max(10),
  flowId: z.string().min(1),
});

/**
 * POST /api/auth/verify-otp — body `{ otp, flowId }`
 *
 * Completes MFA. The cookies captured here are what make later unattended logins
 * possible, so the response reports which ones arrived.
 */
export async function verifyOtp(req: Request, res: Response): Promise<void> {
  const { otp, flowId } = verifyOtpSchema.parse(req.body);

  const attempt = await attemptLogin(logger, { otp, flowId });

  if (attempt.accessToken) {
    const jar = await loadCookieJar();
    res.json({
      status: 'SUCCESS',
      message: 'OTP verified and token stored.',
      expiresAt: attempt.expiresAt?.toISOString(),
      cookiesCaptured: cookieNames(jar),
      nextStep:
        'Call POST /api/auth/refresh to check whether a password-only re-login now works. If it does, the automation is fully unattended.',
    });
    return;
  }

  res.status(400).json({
    status: 'VERIFY_FAILED',
    message: attempt.mfaRequired
      ? 'Naukri still wants an OTP — the code may be wrong or expired.'
      : `Naukri returned HTTP ${attempt.status}.`,
    naukriResponse: attempt.body,
  });
}

/**
 * POST /api/auth/refresh
 *
 * Forces a silent re-login — the exact operation the scheduled run depends on. Run
 * this once after verifying an OTP: if it succeeds, unattended operation works. If it
 * returns 503, it does not, and no amount of scheduling will fix that.
 */
export async function refresh(_req: Request, res: Response): Promise<void> {
  const token = await refreshAccessToken(logger);
  res.json({
    status: 'REFRESHED',
    message: 'Silent re-login succeeded — no OTP required. Unattended runs will work.',
    expiresAt: readJwtExpiry(token).toISOString(),
  });
}

/** GET /api/auth/status — token validity plus which cookies are held. */
export async function authStatus(_req: Request, res: Response): Promise<void> {
  const [token, jar] = await Promise.all([
    prisma.naukriToken.findFirst({
      where: { expiresAt: { gt: new Date() } },
      orderBy: { expiresAt: 'desc' },
      select: { issuedAt: true, expiresAt: true, flowId: true },
    }),
    loadCookieJar(),
  ]);

  res.json({
    token: token
      ? {
          status: 'VALID',
          issuedAt: token.issuedAt,
          expiresAt: token.expiresAt,
          minutesRemaining: Math.round((token.expiresAt.getTime() - Date.now()) / 60_000),
          obtainedVia: token.flowId,
        }
      : { status: 'EXPIRED_OR_MISSING' },
    session: { cookiesHeld: cookieNames(jar) },
  });
}

const storeTokenSchema = z.object({ token: z.string().min(20) });

/**
 * POST /api/auth/store-token — body `{ token }`
 *
 * Manual escape hatch: paste a bearer token from your browser. Kept because it works
 * when nothing else does, but note it only buys about an hour — it is a debugging
 * tool, not a substitute for silent re-login.
 */
export async function storeToken(req: Request, res: Response): Promise<void> {
  const { token } = storeTokenSchema.parse(req.body);
  const expiresAt = readJwtExpiry(token);

  if (expiresAt.getTime() <= Date.now()) {
    throw new AppError('That token has already expired.', 400, 'TOKEN_EXPIRED');
  }

  await storeAccessToken(token, expiresAt, 'manual');

  res.json({
    status: 'STORED',
    expiresAt: expiresAt.toISOString(),
    minutesRemaining: Math.round((expiresAt.getTime() - Date.now()) / 60_000),
  });
}

/**
 * DELETE /api/auth/session
 *
 * Drops the cookie jar. Needed when the stored cookies go stale — a jar holding a
 * dead session can make every login fail in ways a clean attempt would not.
 */
export async function resetSession(_req: Request, res: Response): Promise<void> {
  await clearCookieJar();
  res.json({ status: 'CLEARED', message: 'Cookie jar dropped. Next login starts fresh.' });
}

/** GET /api/auth/probe — resolves a usable token the way the worker does. */
export async function probe(_req: Request, res: Response): Promise<void> {
  const token = await getAccessToken(logger);
  res.json({ status: 'OK', expiresAt: readJwtExpiry(token).toISOString() });
}
