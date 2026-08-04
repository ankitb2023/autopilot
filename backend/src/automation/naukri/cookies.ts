import { prisma } from '../../config/prisma';

/**
 * A persistent cookie jar for Naukri.
 *
 * `fetch` deliberately has no cookie jar. Without one, every request AutoPilot makes
 * looks like a brand-new unrecognised device — which is why a second login
 * immediately demands OTP again even though the first one succeeded. Anything Naukri
 * hands back after OTP verification (device trust, refresh credentials, session ids)
 * has to be captured and replayed, or it is lost the moment the response is read.
 *
 * Scope is intentionally small: one host, one account, echo cookies back. No Path or
 * Domain matching, no RFC 6265 completeness — those matter for a browser talking to
 * many origins, not for us talking to naukri.com.
 */

const SESSION_ID = 'default';

export type CookieJar = Record<string, string>;

/** Cookies that must never be persisted — they'd pin us to a stale login. */
const NEVER_PERSIST = new Set(['nauk_at']);

export async function loadCookieJar(): Promise<CookieJar> {
  const row = await prisma.naukriSession.findUnique({ where: { id: SESSION_ID } });
  if (!row) return {};
  return (row.cookies ?? {}) as CookieJar;
}

export async function saveCookieJar(jar: CookieJar): Promise<void> {
  await prisma.naukriSession.upsert({
    where: { id: SESSION_ID },
    create: { id: SESSION_ID, cookies: jar },
    update: { cookies: jar },
  });
}

export async function clearCookieJar(): Promise<void> {
  await prisma.naukriSession.deleteMany({ where: { id: SESSION_ID } });
}

/** Serialises the jar into a `Cookie:` request header, or undefined if empty. */
export function toCookieHeader(jar: CookieJar): string | undefined {
  const pairs = Object.entries(jar).map(([name, value]) => `${name}=${value}`);
  return pairs.length > 0 ? pairs.join('; ') : undefined;
}

/**
 * Merges a response's Set-Cookie headers into the jar.
 *
 * Returns a new jar rather than mutating, so callers decide whether a request's
 * cookies are worth keeping. Deletions (`Max-Age=0` or a past `Expires`) remove the
 * entry — otherwise a logged-out session would linger forever and quietly break
 * every future login.
 */
export function mergeSetCookies(jar: CookieJar, headers: Headers): CookieJar {
  const merged: CookieJar = { ...jar };

  for (const raw of readSetCookies(headers)) {
    const [pair, ...attributes] = raw.split(';');
    if (!pair) continue;

    const eq = pair.indexOf('=');
    if (eq <= 0) continue;

    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name || NEVER_PERSIST.has(name)) continue;

    if (isExpired(attributes)) {
      delete merged[name];
      continue;
    }

    merged[name] = value;
  }

  return merged;
}

/** Names present in the jar — safe to log, unlike the values. */
export function cookieNames(jar: CookieJar): string[] {
  return Object.keys(jar).sort();
}

function readSetCookies(headers: Headers): string[] {
  // getSetCookie preserves each header separately. Falling back to get('set-cookie')
  // would mean splitting a comma-joined string, and `Expires` contains commas — a
  // well-known way to corrupt cookie parsing.
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

function isExpired(attributes: string[]): boolean {
  for (const attribute of attributes) {
    const [rawKey, ...rest] = attribute.split('=');
    const key = rawKey?.trim().toLowerCase();
    const value = rest.join('=').trim();

    if (key === 'max-age') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds <= 0) return true;
    }

    if (key === 'expires') {
      const when = Date.parse(value);
      if (Number.isFinite(when) && when <= Date.now()) return true;
    }
  }
  return false;
}
