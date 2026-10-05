import { env } from '../../config/env';
import type { Logger } from '../../config/logger';
import { AutomationFailedError } from '../../core/errors';
import { loadCookieJar, mergeSetCookies, saveCookieJar, toCookieHeader } from '../naukri/cookies';
import { getAccessToken, refreshCentralLogin } from '../naukri/naukri.auth';
import { fetchProfile } from '../naukri/naukri.profile';
import {
  DEFAULT_ACCOUNT,
  type AutomationAction,
  type AutomationWorker,
  type ExecutionContext,
  type ProviderId,
  type WorkerOutcome,
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

/** The profile a run writes to, and the unchanged skills it writes back. */
interface ProfileTarget {
  profileId: string;
  keySkills: string;
  /** Where the values came from — env vars, or read live from the profile. */
  source: 'env' | 'live';
}

export class NaukriWorker implements AutomationWorker {
  readonly provider: ProviderId = 'naukri';
  readonly supportedActions: readonly AutomationAction[] = ['profile.update'];

  async execute({ account, logger, dryRun, signal }: ExecutionContext): Promise<WorkerOutcome> {
    signal.throwIfAborted();

    // Throws NaukriReauthRequiredError (503, actionable) if a silent re-login fails.
    let token = await getAccessToken(logger, account);

    signal.throwIfAborted();

    const target = await this.resolveTarget(account, token, logger);
    token = target.token;

    if (dryRun) {
      logger.info('dry run: holding a valid token, skipping the write');
      return {
        success: true,
        message: 'Dry run: authenticated, profile not modified.',
        details: {
          profileId: target.profileId,
          keySkills: target.keySkills,
          source: target.source,
        },
      };
    }

    signal.throwIfAborted();

    let response = await this.saveProfile(account, token, target, logger);

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
      token = await refreshCentralLogin(logger, account);
      signal.throwIfAborted();
      response = await this.saveProfile(account, token, target, logger);
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
   * Works out which profile to write and the skills to write back.
   *
   * The default account keeps using NAUKRI_PROFILE_ID / NAUKRI_KEY_SKILLS when both are
   * set, exactly as before. Any other account has no env vars of its own, so its
   * current values are read live from the profile just before the write. Re-saving
   * what was just read is what keeps this idempotent — a hand-copied skills list can
   * go stale and would overwrite the real one.
   *
   * Returns the token too: a 401 on the read is refreshed and retried once, the same
   * single-retry rule the write follows.
   */
  private async resolveTarget(
    account: string,
    token: string,
    logger: Logger,
  ): Promise<ProfileTarget & { token: string }> {
    if (account === DEFAULT_ACCOUNT && env.NAUKRI_PROFILE_ID && env.NAUKRI_KEY_SKILLS) {
      return {
        token,
        profileId: env.NAUKRI_PROFILE_ID,
        keySkills: env.NAUKRI_KEY_SKILLS,
        source: 'env',
      };
    }

    let snapshot = await fetchProfile(token, account, logger);

    if (!snapshot.ok && snapshot.attempts.some((attempt) => attempt.status === 401)) {
      logger.warn('profile read returned 401; refreshing central login and retrying once');
      token = await refreshCentralLogin(logger, account);
      snapshot = await fetchProfile(token, account, logger);
    }

    if (!snapshot.ok || !snapshot.profileId || !snapshot.keySkills) {
      throw new AutomationFailedError(
        `Could not read the current profile for account "${account}", so there is nothing safe to re-save.`,
        {
          attempts: snapshot.attempts,
          foundProfileId: Boolean(snapshot.profileId),
          foundKeySkills: Boolean(snapshot.keySkills),
        },
      );
    }

    return { token, profileId: snapshot.profileId, keySkills: snapshot.keySkills, source: 'live' };
  }

  /**
   * Re-saves the profile's key skills.
   *
   * Sends the cookie jar alongside the bearer token: the gateway has been observed to
   * care about session cookies as well, and replaying them keeps this request
   * indistinguishable from the browser's.
   */
  private async saveProfile(
    account: string,
    token: string,
    { profileId, keySkills }: ProfileTarget,
    logger: Logger,
  ): Promise<{ ok: boolean; status: number; bodyPreview: string }> {
    const jar = await loadCookieJar(account);
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

    await saveCookieJar(account, mergeSetCookies(jar, response.headers));

    const bodyPreview = (await response.text().catch(() => '')).slice(0, 500);
    logger.info('naukri profile save response', { status: response.status, bodyPreview });

    return { ok: response.ok, status: response.status, bodyPreview };
  }
}
