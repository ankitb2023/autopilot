import { env } from '../../config/env';
import type { Logger } from '../../config/logger';
import { prisma } from '../../config/prisma';
import { AppError } from '../../core/errors';
import {
  loadCookieJar,
  mergeSetCookies,
  readAccessTokenCookie,
  saveCookieJar,
  toCookieHeader,
} from './cookies';

/**
 * Naukri authentication.
 *
 * The problem this solves: the access token lives one hour, but the automation runs
 * once a day — so at run time the token is always expired. Getting a new one must
 * therefore be automatic, and it must not require an OTP.
 *
 * The strategy is to do exactly what Naukri's own frontend does. Their `ajaxWrapper`
 * reads the bearer token out of the `nauk_at` cookie, and on a 401 it GETs a
 * central-login refresh endpoint, checks `loggedin`, and replays the request once. That
 * endpoint needs neither password nor OTP — only the long-lived session cookies — which
 * is how a browser stays usable for weeks on a one-hour token.
 *
 * So the ladder is:
 *   1. a stored token that is still valid
 *   2. `refreshCentralLogin` — cookies only, no credentials, the normal path
 *   3. password login — last resort, and the only step that can trigger MFA
 *
 * Only when all three fail does a human need to supply an OTP, and that surfaces as
 * `NaukriReauthRequiredError` naming the exact endpoints to call.
 */

/*
 * Endpoints and header values taken verbatim from Naukri's own login-layer bundle
 * (`LOGIN_API_URL_CENTRAL`, `MFA_OTP_LOGIN_URL`, `RESEND_MFA_OTP_URL`).
 *
 * The distinction below is not cosmetic: MFA verification is a *different endpoint*
 * from login. Posting an OTP back to the login endpoint makes Naukri generate a new
 * OTP instead of verifying the one you have, which burns the daily send quota and
 * fails with `403009 Daily email/sms quota limit reached`.
 */
const LOGIN_URL = 'https://www.naukri.com/central-login-services/v1/login';
const MFA_OTP_LOGIN_URL = 'https://www.naukri.com/central-login-services/v0/otp-login';
const RESEND_MFA_OTP_URL = 'https://www.naukri.com/central-login-services/v0/resend-mfa-otp';

/** Their `LoginSystemId` — the password login uses 'Naukri', OTP calls use 'jobseeker'. */
const LOGIN_SYSTEM_ID = 'Naukri';
const OTP_SYSTEM_ID = 'jobseeker';

/**
 * The central-login refresh endpoint — `REFRESH_CENTRAL_LOGIN_URL` in Naukri's own
 * frontend. This is the mechanism that keeps a browser logged in for weeks on a
 * one-hour token, and it needs no OTP and no password.
 *
 * It looks useless from the outside: the body is only `{loggedin: true}`. The token
 * arrives as a `Set-Cookie: nauk_at=…` side effect, which is why the response body
 * appears empty of anything valuable. `loggedin` is exactly the field their frontend
 * checks before retrying a 401'd request.
 */
const REFRESH_URL = 'https://www.naukri.com/central-login-services/v0/credentials/login-status';

/** Don't hand out a token that expires mid-request. */
const TOKEN_SAFETY_MARGIN_MS = 60_000;

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

/**
 * Naukri needs re-authentication with a human-supplied OTP.
 *
 * 503 rather than 502: nothing is broken, the service is just missing a credential
 * only the account owner can supply. The message names the exact next step.
 */
export class NaukriReauthRequiredError extends AppError {
  constructor(detail: string) {
    super(
      `Naukri re-authentication required: ${detail} Run POST /api/auth/init-login, then POST /api/auth/verify-otp with the emailed code.`,
      503,
      'NAUKRI_REAUTH_REQUIRED',
    );
  }
}

/** Headers Naukri's gateway expects, matching their login layer's request shape. */
function baseHeaders(systemId: string): Record<string, string> {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    appid: '105',
    systemid: systemId,
    clientid: 'd3skt0p',
    'x-requested-with': 'XMLHttpRequest',
    'user-agent': USER_AGENT,
    origin: 'https://www.naukri.com',
    referer: 'https://www.naukri.com/nlogin/login',
  };
}

export interface LoginAttempt {
  /** Naukri wants an OTP before it will issue a token. */
  mfaRequired: boolean;
  flowId?: string;
  email?: string;
  /** Needed to resend the OTP; their resend call requires it alongside flowId. */
  userId?: string;
  /** The username Naukri echoes back — used verbatim when verifying. */
  username?: string;
  accessToken?: string;
  expiresAt?: Date;
  status: number;
  body: unknown;
}

/**
 * Password login. Never carries an OTP — MFA verification is a separate endpoint.
 *
 * A 403 `MFA required` is the expected outcome from an unrecognised device; it means
 * Naukri has emailed a code and is waiting for `verifyMfaOtp`.
 */
export async function attemptLogin(logger: Logger): Promise<LoginAttempt> {
  if (!env.NAUKRI_EMAIL || !env.NAUKRI_PASSWORD) {
    throw new NaukriReauthRequiredError('NAUKRI_EMAIL and NAUKRI_PASSWORD are not set.');
  }

  const jar = await loadCookieJar();
  const cookieHeader = toCookieHeader(jar);

  logger.info('naukri password login attempt', { replayedCookies: Object.keys(jar).length });

  const response = await globalThis.fetch(LOGIN_URL, {
    method: 'POST',
    headers: {
      ...baseHeaders(LOGIN_SYSTEM_ID),
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    body: JSON.stringify({ username: env.NAUKRI_EMAIL, password: env.NAUKRI_PASSWORD }),
  });

  // Persist cookies from every attempt, including the MFA challenge: it sets the
  // device and bot-manager cookies that the verification step is expected to echo.
  await saveCookieJar(mergeSetCookies(jar, response.headers));

  const body: unknown = await response.json().catch(() => ({}));
  const record = asRecord(body);

  if (response.status === 403 && record.message === 'MFA required') {
    const data = asRecord(record.data);
    logger.warn('naukri demanded MFA', { flowId: data.flowId });
    return {
      mfaRequired: true,
      flowId: str(data.flowId),
      email: str(data.email),
      userId: str(data.userId),
      username: str(data.username) ?? env.NAUKRI_EMAIL,
      status: response.status,
      body,
    };
  }

  if (!response.ok) return { mfaRequired: false, status: response.status, body };

  return finishLogin(logger, record, response, 'password');
}

/**
 * Verifies an MFA code.
 *
 * Mirrors their `mfaStepLogin`: POST to the dedicated otp-login endpoint with
 * `{username, token, flowId}` and `SystemId: jobseeker`. The code goes in `token`, and
 * no password is sent — this endpoint verifies, it does not authenticate.
 */
export async function verifyMfaOtp(
  logger: Logger,
  input: { token: string; flowId: string; username?: string },
): Promise<LoginAttempt> {
  const username = input.username ?? env.NAUKRI_EMAIL;
  if (!username) {
    throw new NaukriReauthRequiredError('NAUKRI_EMAIL is not set.');
  }

  const jar = await loadCookieJar();
  const cookieHeader = toCookieHeader(jar);

  logger.info('verifying naukri mfa otp', {
    flowId: input.flowId,
    replayedCookies: Object.keys(jar).length,
  });

  const response = await globalThis.fetch(MFA_OTP_LOGIN_URL, {
    method: 'POST',
    headers: {
      ...baseHeaders(OTP_SYSTEM_ID),
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    body: JSON.stringify({ username, token: input.token, flowId: input.flowId }),
  });

  await saveCookieJar(mergeSetCookies(jar, response.headers));

  const body: unknown = await response.json().catch(() => ({}));
  const record = asRecord(body);

  if (!response.ok) {
    logger.warn('mfa verification rejected', { status: response.status });
    return { mfaRequired: true, flowId: input.flowId, status: response.status, body };
  }

  return finishLogin(logger, record, response, input.flowId);
}

/**
 * Asks Naukri to send a new code for an in-flight MFA challenge.
 *
 * Exists so a mistyped or expired code doesn't force a fresh password login — which
 * would consume another send from the daily quota on top of this one.
 */
export async function resendMfaOtp(
  logger: Logger,
  input: { flowId: string; userId?: string; username?: string },
): Promise<{ status: number; body: unknown }> {
  const username = input.username ?? env.NAUKRI_EMAIL;
  const jar = await loadCookieJar();
  const cookieHeader = toCookieHeader(jar);

  const response = await globalThis.fetch(RESEND_MFA_OTP_URL, {
    method: 'POST',
    headers: {
      ...baseHeaders(OTP_SYSTEM_ID),
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    body: JSON.stringify({ username, userId: input.userId, flowId: input.flowId }),
  });

  await saveCookieJar(mergeSetCookies(jar, response.headers));
  const body: unknown = await response.json().catch(() => ({}));

  logger.info('requested a new mfa otp', { status: response.status });
  return { status: response.status, body };
}

/** Shared tail of both login paths: pull out the token, store it, report back. */
async function finishLogin(
  logger: Logger,
  record: Record<string, unknown>,
  response: Response,
  obtainedVia: string,
): Promise<LoginAttempt> {
  const token = extractAccessToken(record, response.headers);

  if (!token) {
    logger.error('naukri login succeeded but no token was found', {
      bodyKeys: Object.keys(record),
    });
    return { mfaRequired: false, status: response.status, body: record };
  }

  const expiresAt = readJwtExpiry(token);
  await storeAccessToken(token, expiresAt, obtainedVia);

  logger.info('naukri token obtained', { via: obtainedVia, expiresAt: expiresAt.toISOString() });

  return {
    mfaRequired: false,
    accessToken: token,
    expiresAt,
    status: response.status,
    body: record,
  };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Exchanges the long-lived session cookies for a fresh access token.
 *
 * This is the unattended renewal path, copied from what Naukri's frontend does on a
 * 401: GET the refresh endpoint with cookies attached, confirm `loggedin`, then read
 * the new `nauk_at` out of Set-Cookie. No password, no OTP.
 *
 * `loggedin: false` means the underlying session itself is dead — that is the one case
 * a human has to fix, and their frontend responds by redirecting to the login page.
 */
export async function refreshCentralLogin(logger: Logger): Promise<string> {
  const jar = await loadCookieJar();
  const cookieHeader = toCookieHeader(jar);

  if (!cookieHeader) {
    throw new NaukriReauthRequiredError('no session cookies are stored.');
  }

  const response = await globalThis.fetch(REFRESH_URL, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      appid: '105',
      // Their frontend overrides systemid to 'jobseeker' for exactly this call.
      systemid: 'jobseeker',
      'x-requested-with': 'XMLHttpRequest',
      'cache-control': 'no-cache, no-store, must-revalidate',
      'user-agent': USER_AGENT,
      referer: 'https://www.naukri.com/mnjuser/profile',
      cookie: cookieHeader,
    },
  });

  const updatedJar = mergeSetCookies(jar, response.headers);
  await saveCookieJar(updatedJar);

  const body = asRecord(await response.json().catch(() => ({})));

  if (!response.ok) {
    throw new NaukriReauthRequiredError(`refresh endpoint returned HTTP ${response.status}.`);
  }

  if (body.loggedin !== true) {
    throw new NaukriReauthRequiredError('the stored session is no longer logged in.');
  }

  const token = readAccessTokenCookie(updatedJar);
  if (!token) {
    throw new NaukriReauthRequiredError(
      'refresh reported loggedin but returned no nauk_at cookie.',
    );
  }

  const expiresAt = readJwtExpiry(token);
  await storeAccessToken(token, expiresAt, 'central-login-refresh');

  logger.info('refreshed naukri token via central login', {
    expiresAt: expiresAt.toISOString(),
  });

  return token;
}

/**
 * Returns a usable access token.
 *
 * The only function the worker should call. Order of preference mirrors cost: a stored
 * token, then a cookie-only refresh, and password login solely as a last resort — that
 * one can trigger MFA, so it is not something to attempt casually on a schedule.
 */
export async function getAccessToken(logger: Logger): Promise<string> {
  const stored = await prisma.naukriToken.findFirst({
    where: { expiresAt: { gt: new Date(Date.now() + TOKEN_SAFETY_MARGIN_MS) } },
    // Newest first, not longest-lived first: a refresh issues a token with the same
    // one-hour lifetime as the one it replaces, so ordering by expiry can tie and hand
    // back the token we just superseded.
    orderBy: { issuedAt: 'desc' },
  });

  if (stored) {
    logger.info('using stored naukri token', {
      minutesRemaining: Math.round((stored.expiresAt.getTime() - Date.now()) / 60_000),
    });
    return stored.accessToken;
  }

  logger.info('no usable token; refreshing via central login');

  try {
    return await refreshCentralLogin(logger);
  } catch (error) {
    if (!(error instanceof NaukriReauthRequiredError)) throw error;

    logger.warn('cookie refresh failed; falling back to password login', {
      reason: error.message,
    });
    return refreshAccessToken(logger);
  }
}

/**
 * Obtains a fresh token without human involvement, using the stored cookies.
 *
 * Succeeds only if Naukri treats this caller as a known device. If it demands OTP,
 * that is a hard stop — we say so plainly instead of retrying into a lockout.
 */
export async function refreshAccessToken(logger: Logger): Promise<string> {
  const attempt = await attemptLogin(logger);

  if (attempt.mfaRequired) {
    throw new NaukriReauthRequiredError(
      'Naukri does not recognise this device, so password-only login was refused.',
    );
  }

  if (!attempt.accessToken) {
    throw new NaukriReauthRequiredError(
      `login returned HTTP ${attempt.status} without a token.`,
    );
  }

  return attempt.accessToken;
}

/** Persists a token and drops expired rows so the table doesn't grow forever. */
export async function storeAccessToken(
  accessToken: string,
  expiresAt: Date,
  flowId: string | null,
): Promise<void> {
  await prisma.naukriToken.create({ data: { accessToken, expiresAt, flowId } });
  await prisma.naukriToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
}

/** Reads `exp` from the JWT payload, falling back to one hour. */
export function readJwtExpiry(token: string): Date {
  const fallback = new Date(Date.now() + 3_600_000);
  const payloadSegment = token.split('.')[1];
  if (!payloadSegment) return fallback;

  try {
    const payload = asRecord(
      JSON.parse(Buffer.from(payloadSegment, 'base64url').toString()) as unknown,
    );
    return typeof payload.exp === 'number' ? new Date(payload.exp * 1000) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Finds the access token, which Naukri has been observed to return in several
 * shapes. The cookie is checked last and read from the raw headers, since the jar
 * deliberately never persists `nauk_at`.
 */
function extractAccessToken(body: Record<string, unknown>, headers: Headers): string | undefined {
  const fields = ['token', 'accessToken', 'access_token', 'nauk_at', 'id_token'];

  for (const source of [body, asRecord(body.data)]) {
    for (const field of fields) {
      const value = source[field];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  }

  const setCookies =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers.get('set-cookie') ?? ''];

  for (const raw of setCookies) {
    const match = /(?:^|;\s*)nauk_at=([^;]+)/.exec(raw);
    if (match?.[1]) return match[1];
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
