import type { Logger } from '../../config/logger';
import { loadCookieJar, toCookieHeader } from './cookies';

/**
 * Read-only profile fetch.
 *
 * Two jobs, both diagnostic:
 *
 *  1. It is the only authenticated Naukri call we can make without writing anything,
 *     so it answers "does a token minted at one IP work from another?" — the access
 *     token embeds an `ipAdress` claim, and whether Naukri enforces it decides whether
 *     this can run on Render at all.
 *
 *  2. It reports the profile's current `keySkills` and id, which is what
 *     NAUKRI_KEY_SKILLS and NAUKRI_PROFILE_ID must be set to. Guessing those and then
 *     writing would overwrite a real profile with a stale skills list.
 */

const PROFILE_URL =
  'https://www.naukri.com/cloudgateway-mynaukri/resman-aggregator-services/v1/users/self/fullprofiles';

export interface ProfileSnapshot {
  status: number;
  ok: boolean;
  profileId?: string;
  keySkills?: string;
  /** Truncated raw body, so an unexpected shape is still debuggable. */
  bodyPreview: string;
}

export async function fetchProfile(token: string, logger: Logger): Promise<ProfileSnapshot> {
  const jar = await loadCookieJar();
  const cookieHeader = toCookieHeader(jar);

  const response = await globalThis.fetch(PROFILE_URL, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      appid: '105',
      clientid: 'd3skt0p',
      systemid: 'Naukri',
      'x-requested-with': 'XMLHttpRequest',
      referer: 'https://www.naukri.com/mnjuser/profile',
      'user-agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
  });

  const text = await response.text().catch(() => '');
  logger.info('naukri profile fetch', { status: response.status, bytes: text.length });

  const snapshot: ProfileSnapshot = {
    status: response.status,
    ok: response.ok,
    bodyPreview: text.slice(0, 400),
  };

  // The response nests the profile differently across versions, so probe the likely
  // shapes rather than asserting one.
  try {
    const parsed: unknown = JSON.parse(text);
    const root = asRecord(parsed);
    const profile = asRecord(root.profile ?? asRecord(root.dashboardProfile).profile ?? root);

    const keySkills = profile.keySkills ?? root.keySkills;
    if (typeof keySkills === 'string') snapshot.keySkills = keySkills;

    const profileId = root.profileId ?? profile.profileId ?? profile.id;
    if (typeof profileId === 'string') snapshot.profileId = profileId;
  } catch {
    // Leave the preview for inspection; a non-JSON body is itself the finding.
  }

  return snapshot;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
