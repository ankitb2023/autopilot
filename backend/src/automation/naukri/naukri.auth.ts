import { env } from '../../config/env';
import type { Logger } from '../../config/logger';
import { prisma } from '../../config/prisma';
import { AppError } from '../../core/errors';
import { loadCookieJar, mergeSetCookies, saveCookieJar, toCookieHeader } from './cookies';

/**
 * Naukri authentication.
 *
 * The problem this solves: the access token lives one hour, but the automation runs
 * once a day — so at run time the token is always expired. Getting a new one must
 * therefore be automatic, and it must not require an OTP.
 *
 * The strategy is to behave like the browser does. A browser stays logged in for
 * weeks despite the same one-hour token, which means a non-OTP path to a fresh token
 * exists; the browser's advantage is simply that it keeps every cookie Naukri gives
 * it. So we keep them too (see cookies.ts) and replay them on re-login.
 *
 * Whether that is sufficient depends on how Naukri implements MFA:
 *   - if OTP verification marks the device trusted, replaying those cookies makes
 *     password-only re-login succeed, and this is fully unattended;
 *   - if it does not, `refreshAccessToken` throws `NaukriReauthRequiredError` with an
 *     actionable message rather than failing obscurely.
 *
 * Either way the failure is explicit and the manual escape hatch still works.
 */

const LOGIN_URL = 'https://www.naukri.com/central-login-services/v1/login';

/** Don't hand out a token that expires mid-request. */
const TOKEN_SAFETY_MARGIN_MS = 60_000;

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

/** Headers Naukri's gateway expects. Sent on every call so behaviour is consistent. */
function baseHeaders(): Record<string, string> {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    appid: '105',
    systemid: 'jobseeker',
    clientid: 'd3skt0p',
    'x-requested-with': 'XMLHttpRequest',
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    origin: 'https://www.naukri.com',
    referer: 'https://www.naukri.com/nlogin/login',
  };
}

export interface LoginAttempt {
  /** Naukri wants an OTP before it will issue a token. */
  mfaRequired: boolean;
  flowId?: string;
  email?: string;
  accessToken?: string;
  expiresAt?: Date;
  status: number;
  body: unknown;
}

/**
 * Performs a login call, replaying the stored cookie jar and capturing whatever comes
 * back. `otp` + `flowId` turn this into the MFA verification step — the endpoint is
 * the same, which is why one function covers both.
 */
export async function attemptLogin(
  logger: Logger,
  credentials?: { otp: string; flowId: string },
): Promise<LoginAttempt> {
  if (!env.NAUKRI_EMAIL || !env.NAUKRI_PASSWORD) {
    throw new NaukriReauthRequiredError('NAUKRI_EMAIL and NAUKRI_PASSWORD are not set.');
  }

  const jar = await loadCookieJar();
  const cookieHeader = toCookieHeader(jar);

  logger.info('naukri login attempt', {
    withOtp: credentials !== undefined,
    replayedCookies: Object.keys(jar).length,
  });

  const response = await globalThis.fetch(LOGIN_URL, {
    method: 'POST',
    headers: {
      ...baseHeaders(),
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    body: JSON.stringify({
      username: env.NAUKRI_EMAIL,
      password: env.NAUKRI_PASSWORD,
      ...(credentials ? { otp: credentials.otp, flowId: credentials.flowId } : {}),
    }),
  });

  // Persist cookies from *every* attempt, including failures: an MFA challenge often
  // sets the flow-tracking cookie that the verification step is expected to send back.
  const updatedJar = mergeSetCookies(jar, response.headers);
  await saveCookieJar(updatedJar);

  const body: unknown = await response.json().catch(() => ({}));
  const record = asRecord(body);

  if (response.status === 403 && record.message === 'MFA required') {
    const data = asRecord(record.data);
    logger.warn('naukri demanded MFA', { flowId: data.flowId });
    return {
      mfaRequired: true,
      flowId: typeof data.flowId === 'string' ? data.flowId : undefined,
      email: typeof data.email === 'string' ? data.email : undefined,
      status: response.status,
      body,
    };
  }

  if (!response.ok) {
    return { mfaRequired: false, status: response.status, body };
  }

  const token = extractAccessToken(record, response.headers);
  if (!token) {
    logger.error('naukri login succeeded but no token was found', {
      bodyKeys: Object.keys(record),
    });
    return { mfaRequired: false, status: response.status, body };
  }

  const expiresAt = readJwtExpiry(token);
  await storeAccessToken(token, expiresAt, credentials ? credentials.flowId : 'password');

  logger.info('naukri token obtained', {
    expiresAt: expiresAt.toISOString(),
    cookiesHeld: Object.keys(updatedJar).length,
  });

  return { mfaRequired: false, accessToken: token, expiresAt, status: response.status, body };
}

/**
 * Returns a usable access token, logging in again if the stored one is gone or stale.
 *
 * This is the only function the worker should call. It never prompts, never blocks —
 * it either produces a token or throws something actionable.
 */
export async function getAccessToken(logger: Logger): Promise<string> {
  const stored = await prisma.naukriToken.findFirst({
    where: { expiresAt: { gt: new Date(Date.now() + TOKEN_SAFETY_MARGIN_MS) } },
    orderBy: { expiresAt: 'desc' },
  });

  if (stored) {
    logger.info('using stored naukri token', {
      minutesRemaining: Math.round((stored.expiresAt.getTime() - Date.now()) / 60_000),
    });
    return stored.accessToken;
  }

  logger.info('no usable token; attempting silent re-login');
  return refreshAccessToken(logger);
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
