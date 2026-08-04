import type { Logger } from '../../config/logger';
import { loadCookieJar, toCookieHeader } from './cookies';

/**
 * Read-only profile fetch.
 *
 * Reports the profile's current `keySkills` and id — the values NAUKRI_KEY_SKILLS and
 * NAUKRI_PROFILE_ID must hold. Guessing those and then writing would overwrite a real
 * profile with a stale skills list, so this exists to be run before the first write.
 *
 * The URL is *not* the write endpoint: `v1/users/self/fullprofiles` answers GET with
 * 405. The path below is what their suggester plugin uses to read `keySkills`, with the
 * `AppId: 135` it sends. A second candidate follows as a fallback (`USER_PROFILE_API_URL`
 * in their browser config) since neither is documented as canonical.
 */

interface ReadCandidate {
  url: string;
  appId: string;
}

const READ_CANDIDATES: ReadCandidate[] = [
  {
    url: 'https://www.naukri.com/cloudgateway-mynaukri/resman-aggregator-services/v0/users/self?expand_level=2',
    appId: '135',
  },
  {
    url: 'https://www.naukri.com/cloudgateway-mynaukri/resman-aggregator-services/v2/users/self',
    appId: '105',
  },
];

export interface ProfileAttempt {
  url: string;
  status: number;
  bytes: number;
}

export interface ProfileSnapshot {
  ok: boolean;
  /** Which candidate answered. */
  source?: string;
  profileId?: string;
  keySkills?: string;
  attempts: ProfileAttempt[];
  bodyPreview: string;
}

export async function fetchProfile(token: string, logger: Logger): Promise<ProfileSnapshot> {
  const jar = await loadCookieJar();
  const cookieHeader = toCookieHeader(jar);
  const attempts: ProfileAttempt[] = [];

  for (const candidate of READ_CANDIDATES) {
    const response = await globalThis.fetch(candidate.url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        appid: candidate.appId,
        systemid: 'Naukri',
        'x-requested-with': 'XMLHttpRequest',
        referer: 'https://www.naukri.com/mnjuser/profile',
        'user-agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
    });

    const text = await response.text().catch(() => '');
    attempts.push({ url: candidate.url, status: response.status, bytes: text.length });
    logger.info('naukri profile read attempt', { status: response.status, bytes: text.length });

    if (!response.ok) continue;

    return { ok: true, source: candidate.url, ...extract(text), attempts, bodyPreview: text.slice(0, 600) };
  }

  return { ok: false, attempts, bodyPreview: '' };
}

/**
 * Digs `keySkills` and the profile id out of the response.
 *
 * Walks the whole tree for those two keys rather than assuming a path, because the
 * shape differs between the candidate endpoints.
 */
function extract(text: string): { keySkills?: string; profileId?: string } {
  const result: { keySkills?: string; profileId?: string } = {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return result;
  }

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== 'object') return;

    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'keySkills' && typeof value === 'string' && !result.keySkills) {
        result.keySkills = value;
      }
      if (key === 'profileId' && typeof value === 'string' && !result.profileId) {
        result.profileId = value;
      }
      walk(value);
    }
  };

  walk(parsed);
  return result;
}
