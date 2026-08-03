import type { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { logger } from '../config/logger';

/**
 * POST /api/auth/init-login
 * 
 * Step 1 of MFA login: calls Naukri's login API with email/password.
 * Since we're calling from a cloud IP, Naukri triggers MFA and sends an OTP to the user's email.
 * Returns the flowId needed for Step 2.
 */
export async function initLogin(_req: Request, res: Response): Promise<void> {
  if (!env.NAUKRI_EMAIL || !env.NAUKRI_PASSWORD) {
    res.status(400).json({ error: 'NAUKRI_EMAIL and NAUKRI_PASSWORD must be set in environment.' });
    return;
  }

  try {
    const loginResponse = await globalThis.fetch(
      'https://www.naukri.com/central-login-services/v1/login',
      {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'content-type': 'application/json',
          'appid': '105',
          'systemid': 'jobseeker',
          'clientid': 'd3skt0p',
          'x-requested-with': 'XMLHttpRequest',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
          'origin': 'https://www.naukri.com',
          'referer': 'https://www.naukri.com/nlogin/login',
        },
        body: JSON.stringify({ username: env.NAUKRI_EMAIL, password: env.NAUKRI_PASSWORD }),
      }
    );

    const data = await loginResponse.json() as Record<string, unknown>;
    
    if (loginResponse.status === 403 && data.message === 'MFA required') {
      const mfaData = data.data as Record<string, unknown>;
      res.json({
        status: 'MFA_REQUIRED',
        message: 'OTP has been sent to your email. Use /api/auth/verify-otp to complete login.',
        flowId: mfaData.flowId,
        email: mfaData.email,
      });
      return;
    }

    if (loginResponse.ok) {
      // Direct login succeeded (no MFA) — extract and store token
      const token = await extractAndStoreToken(data, loginResponse.headers, null);
      if (token) {
        res.json({ status: 'LOGIN_SUCCESS', message: 'Logged in successfully. Token stored.' });
      } else {
        res.status(500).json({ status: 'TOKEN_EXTRACTION_FAILED', data });
      }
      return;
    }

    res.status(loginResponse.status).json({ 
      status: 'LOGIN_FAILED', 
      naukriResponse: data 
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('init-login failed', { error: message });
    res.status(500).json({ error: message });
  }
}

/**
 * POST /api/auth/verify-otp
 * Body: { "otp": "123456", "flowId": "mfa-login-email" }
 * 
 * Step 2 of MFA login: verifies the OTP sent to the user's email.
 * On success, stores the JWT token in the database for automated use.
 */
export async function verifyOtp(req: Request, res: Response): Promise<void> {
  const { otp, flowId } = req.body as { otp?: string; flowId?: string };

  if (!otp || !flowId) {
    res.status(400).json({ error: 'Both "otp" and "flowId" are required.' });
    return;
  }

  if (!env.NAUKRI_EMAIL || !env.NAUKRI_PASSWORD) {
    res.status(400).json({ error: 'NAUKRI_EMAIL and NAUKRI_PASSWORD must be set.' });
    return;
  }

  try {
    const verifyResponse = await globalThis.fetch(
      'https://www.naukri.com/central-login-services/v1/login',
      {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'content-type': 'application/json',
          'appid': '105',
          'systemid': 'jobseeker',
          'clientid': 'd3skt0p',
          'x-requested-with': 'XMLHttpRequest',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
          'origin': 'https://www.naukri.com',
          'referer': 'https://www.naukri.com/nlogin/login',
        },
        body: JSON.stringify({
          username: env.NAUKRI_EMAIL,
          password: env.NAUKRI_PASSWORD,
          otp,
          flowId,
        }),
      }
    );

    const data = await verifyResponse.json() as Record<string, unknown>;
    logger.info('OTP verify response', { status: verifyResponse.status, keys: Object.keys(data) });

    if (verifyResponse.ok) {
      const token = await extractAndStoreToken(data, verifyResponse.headers, flowId);
      if (token) {
        res.json({ 
          status: 'SUCCESS', 
          message: 'OTP verified! Token stored. Automated profile updates will now work.' 
        });
      } else {
        // Return the full response so user can help debug
        res.status(500).json({ 
          status: 'TOKEN_EXTRACTION_FAILED', 
          message: 'Login succeeded but could not find token. See response.',
          naukriResponse: data,
          setCookie: verifyResponse.headers.get('set-cookie')?.substring(0, 200),
        });
      }
      return;
    }

    res.status(verifyResponse.status).json({ 
      status: 'VERIFY_FAILED', 
      naukriResponse: data 
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('verify-otp failed', { error: message });
    res.status(500).json({ error: message });
  }
}

/**
 * GET /api/auth/token-status
 * 
 * Check if we have a valid stored token.
 */
export async function tokenStatus(_req: Request, res: Response): Promise<void> {
  const token = await prisma.naukriToken.findFirst({
    where: { expiresAt: { gt: new Date() } },
    orderBy: { expiresAt: 'desc' },
    select: { id: true, issuedAt: true, expiresAt: true, flowId: true },
  });

  if (token) {
    res.json({ 
      status: 'VALID', 
      issuedAt: token.issuedAt, 
      expiresAt: token.expiresAt,
      minutesRemaining: Math.round((token.expiresAt.getTime() - Date.now()) / 60000),
    });
  } else {
    res.json({ 
      status: 'EXPIRED_OR_MISSING', 
      message: 'No valid token. Use POST /api/auth/store-token to paste your bearer token.' 
    });
  }
}

/**
 * POST /api/auth/store-token
 * Body: { "token": "eyJraWQ..." }
 * 
 * Directly store a bearer token copied from your browser.
 * How to get it: Open Naukri in Chrome → DevTools → Application → Cookies → copy `nauk_at` value.
 */
export async function storeToken(req: Request, res: Response): Promise<void> {
  const { token } = req.body as { token?: string };

  if (!token) {
    res.status(400).json({ 
      error: 'Provide "token" in the body. Get it from Chrome DevTools → Application → Cookies → nauk_at value.' 
    });
    return;
  }

  // Decode JWT to get expiry
  let expiresAt = new Date(Date.now() + 3600 * 1000); // default 1 hour
  try {
    const parts = token.split('.');
    if (parts.length === 3 && parts[1]) {
      const payload = JSON.parse(
        Buffer.from(parts[1], 'base64url').toString()
      ) as Record<string, unknown>;
      if (typeof payload.exp === 'number') {
        expiresAt = new Date(payload.exp * 1000);
      }
      logger.info('decoded JWT', { 
        userId: payload.userId, 
        expiresAt: expiresAt.toISOString(),
        minutesRemaining: Math.round((expiresAt.getTime() - Date.now()) / 60000),
      });
    }
  } catch {
    logger.warn('could not decode JWT expiry, defaulting to 1 hour');
  }

  if (expiresAt.getTime() <= Date.now()) {
    res.status(400).json({ error: 'This token has already expired. Please copy a fresh one from your browser.' });
    return;
  }

  // Store in database
  await prisma.naukriToken.create({
    data: { accessToken: token, expiresAt, flowId: 'manual' },
  });

  const minutesRemaining = Math.round((expiresAt.getTime() - Date.now()) / 60000);
  res.json({ 
    status: 'STORED', 
    message: `Token stored successfully! Valid for ~${minutesRemaining} minutes. Run profile update now!`,
    expiresAt: expiresAt.toISOString(),
    minutesRemaining,
  });
}

/**
 * Extract JWT token from Naukri API response and store it in the database.
 */
async function extractAndStoreToken(
  data: Record<string, unknown>, 
  headers: Headers, 
  flowId: string | null
): Promise<boolean> {
  let accessToken: string | null = null;

  // Try response body fields
  const possibleFields = ['token', 'accessToken', 'access_token', 'nauk_at'];
  for (const field of possibleFields) {
    if (typeof data[field] === 'string') {
      accessToken = data[field] as string;
      logger.info(`found token in response body field: ${field}`);
      break;
    }
  }

  // Try nested data object
  if (!accessToken && data.data && typeof data.data === 'object') {
    const nested = data.data as Record<string, unknown>;
    for (const field of possibleFields) {
      if (typeof nested[field] === 'string') {
        accessToken = nested[field] as string;
        logger.info(`found token in response body data.${field}`);
        break;
      }
    }
  }

  // Try Set-Cookie header for nauk_at
  if (!accessToken) {
    const setCookie = headers.get('set-cookie');
    if (setCookie) {
      const match = setCookie.match(/nauk_at=([^;]+)/);
      if (match?.[1]) {
        accessToken = match[1];
        logger.info('found token in Set-Cookie header (nauk_at)');
      }
    }
  }

  if (!accessToken) {
    logger.warn('could not find token in response', { 
      bodyKeys: Object.keys(data),
      dataPreview: JSON.stringify(data).substring(0, 500),
    });
    return false;
  }

  // Decode JWT to get expiry (JWT is base64url encoded, payload is the 2nd segment)
  let expiresAt = new Date(Date.now() + 3600 * 1000); // default 1 hour
  try {
    const payload = JSON.parse(
      Buffer.from(accessToken.split('.')[1]!, 'base64url').toString()
    ) as Record<string, unknown>;
    if (typeof payload.exp === 'number') {
      expiresAt = new Date(payload.exp * 1000);
    }
  } catch {
    logger.warn('could not decode JWT expiry, defaulting to 1 hour');
  }

  // Store in database
  await prisma.naukriToken.create({
    data: { accessToken, expiresAt, flowId },
  });

  logger.info('token stored in database', { expiresAt: expiresAt.toISOString() });
  return true;
}
