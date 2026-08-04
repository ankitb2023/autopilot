import { env } from '../../config/env';
import type { Logger } from '../../config/logger';
import { AutomationFailedError } from '../../core/errors';
import { loadCookieJar, mergeSetCookies, saveCookieJar, toCookieHeader } from '../naukri/cookies';
import { getAccessToken, refreshCentralLogin } from '../naukri/naukri.auth';
import type {
  AutomationAction,
  AutomationWorker,
  ExecutionContext,
  ProviderId,
  WorkerOutcome,
} from '../types';

/**
 * Naukri worker — direct API, no browser.
 *
 * Playwright was abandoned here for a good reason: Naukri sits behind Akamai bot
 * detection, which served a blank page and an access-denied interstitial. Driving the
 * same JSON API the site's own frontend calls avoids that fight entirely.
 *
 * Re-saving the profile's key skills is what refreshes the "last updated" timestamp
 * recruiters sort by — the skills themselves are unchanged, which is why this is
 * idempotent and safe to run daily.
 */

const PROFILE_URL =
  'https://www.naukri.com/cloudgateway-mynaukri/resman-aggregator-services/v1/users/self/fullprofiles';

export class NaukriWorker implements AutomationWorker {
  readonly provider: ProviderId = 'naukri';
  readonly supportedActions: readonly AutomationAction[] = ['profile.update'];

  async execute({ logger, dryRun, signal }: ExecutionContext): Promise<WorkerOutcome> {
    const profileId = env.NAUKRI_PROFILE_ID;
    if (!profileId) {
      throw new AutomationFailedError(
        'NAUKRI_PROFILE_ID is not set. Capture it from the Network tab while saving your profile.',
      );
    }

    signal.throwIfAborted();

    // Throws NaukriReauthRequiredError (503, actionable) if a silent re-login fails.
    let token = await getAccessToken(logger);

    if (dryRun) {
      logger.info('dry run: holding a valid token, skipping the write');
      return { success: true, message: 'Dry run: authenticated, profile not modified.' };
    }

    signal.throwIfAborted();

    let response = await this.saveProfile(token, profileId, logger);

    /*
     * 401 handling, mirroring Naukri's own frontend (`do401Handling` in their ajax.js):
     * hit the central-login refresh endpoint, then replay the request exactly once.
     *
     * Their `isRefreshCentralLoginDone` flag guarantees a single retry, and we match
     * that deliberately. Looping here would mean repeatedly presenting credentials to
     * an auth endpoint, which is how accounts get locked.
     */
    if (response.status === 401) {
      logger.warn('profile save returned 401; refreshing central login and retrying once');
      token = await refreshCentralLogin(logger);
      signal.throwIfAborted();
      response = await this.saveProfile(token, profileId, logger);
    }

    if (response.status === 401) {
      throw new AutomationFailedError(
        'Naukri rejected a freshly issued token. The account likely needs interactive re-authentication.',
        { status: 401 },
      );
    }

    if (!response.ok) {
      // A non-401 rejection is a genuine failure worth surfacing verbatim: it is how
      // we will find out the API contract changed.
      return {
        success: false,
        message: `Naukri profile save returned HTTP ${response.status}.`,
        details: { status: response.status, body: response.bodyPreview },
      };
    }

    logger.info('naukri profile saved');
    return {
      success: true,
      message: 'Naukri profile updated.',
      details: { status: response.status },
    };
  }

  /**
   * Re-saves the profile's key skills.
   *
   * Sends the cookie jar alongside the bearer token: the gateway has been observed to
   * care about session cookies as well, and replaying them keeps this request
   * indistinguishable from the browser's.
   */
  private async saveProfile(
    token: string,
    profileId: string,
    logger: Logger,
  ): Promise<{ ok: boolean; status: number; bodyPreview: string }> {
    const keySkills = env.NAUKRI_KEY_SKILLS;
    if (!keySkills) {
      throw new AutomationFailedError(
        'NAUKRI_KEY_SKILLS is not set. It must hold your current comma-separated skills, which are re-saved unchanged.',
      );
    }

    const jar = await loadCookieJar();
    const cookieHeader = toCookieHeader(jar);

    const response = await globalThis.fetch(PROFILE_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        appid: '105',
        clientid: 'd3skt0p',
        systemid: 'Naukri',
        // The gateway routes PUT semantics through POST via this override.
        'x-http-method-override': 'PUT',
        'x-requested-with': 'XMLHttpRequest',
        origin: 'https://www.naukri.com',
        referer: 'https://www.naukri.com/mnjuser/profile',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
      body: JSON.stringify({ profile: { keySkills }, profileId }),
    });

    await saveCookieJar(mergeSetCookies(jar, response.headers));

    const bodyPreview = (await response.text().catch(() => '')).slice(0, 500);
    logger.info('naukri profile save response', { status: response.status, bodyPreview });

    return { ok: response.ok, status: response.status, bodyPreview };
  }
}
