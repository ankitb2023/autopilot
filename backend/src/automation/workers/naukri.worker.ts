import type {
  AutomationAction,
  AutomationWorker,
  ExecutionContext,
  ProviderId,
  WorkerOutcome,
} from '../types';
import { env } from '../../config/env';

/**
 * Naukri automation worker — Direct API approach.
 * 
 * Instead of launching a browser (which gets blocked by Akamai WAF on cloud servers),
 * this worker calls Naukri's internal REST APIs directly:
 * 1. Logs in via the login API to get a fresh JWT Bearer token
 * 2. Calls the profile update API to re-save Key Skills (triggers "profile updated today")
 */
export class NaukriWorker implements AutomationWorker {
  readonly provider: ProviderId = 'naukri';
  readonly supportedActions: readonly AutomationAction[] = ['profile.update'];

  async execute({ logger, dryRun, signal }: ExecutionContext): Promise<WorkerOutcome> {
    logger.info('naukri worker starting (API mode)', { dryRun });
    signal.throwIfAborted();

    try {
      // ── Step 1: Authenticate ─────────────────────────────────────────
      let bearerToken: string | null = null;

      if (env.NAUKRI_EMAIL && env.NAUKRI_PASSWORD) {
        logger.info('logging in via Naukri API to get fresh token');
        bearerToken = await this.loginViaApi(env.NAUKRI_EMAIL, env.NAUKRI_PASSWORD, logger);
      }

      if (!bearerToken) {
        return {
          success: false,
          message: 'Failed to obtain bearer token. Check NAUKRI_EMAIL and NAUKRI_PASSWORD.',
          details: {},
        };
      }

      logger.info('successfully obtained bearer token');
      signal.throwIfAborted();

      if (dryRun) {
        logger.info('dry run: skipping actual profile update');
        return { success: true, message: 'Dry run completed — login successful.', details: { dryRun: true } };
      }

      // ── Step 2: Update profile via API ───────────────────────────────
      const keySkills = env.NAUKRI_KEY_SKILLS 
        || 'Core Java Programming,React.js,Javascript,Redux,Spring Boot,Elastic Search,Kibana,Redis,SQL,DBMS,HTML,CSS,Software Development,Software Engineering,GIT,TypeScript,Nextjs,Data Structures and Algorithms,System Design,Jenkins,Rest API Design';

      const profileId = env.NAUKRI_PROFILE_ID;
      if (!profileId) {
        return {
          success: false,
          message: 'NAUKRI_PROFILE_ID is not set. Get it from browser Network tab when saving profile.',
          details: {},
        };
      }

      logger.info('calling Naukri profile update API');

      const updateResponse = await globalThis.fetch(
        'https://www.naukri.com/cloudgateway-mynaukri/resman-aggregator-services/v1/users/self/fullprofiles',
        {
          method: 'POST',
          headers: {
            'accept': 'application/json',
            'content-type': 'application/json',
            'authorization': `Bearer ${bearerToken}`,
            'appid': '105',
            'clientid': 'd3skt0p',
            'systemid': 'Naukri',
            'x-http-method-override': 'PUT',
            'x-requested-with': 'XMLHttpRequest',
            'origin': 'https://www.naukri.com',
            'referer': 'https://www.naukri.com/mnjuser/profile',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
          },
          body: JSON.stringify({
            profile: { keySkills },
            profileId,
          }),
        }
      );

      const responseText = await updateResponse.text();
      logger.info('profile update response', { 
        status: updateResponse.status, 
        body: responseText.substring(0, 500) 
      });

      if (updateResponse.ok) {
        return {
          success: true,
          message: 'Naukri profile updated successfully via API!',
          details: { 
            status: updateResponse.status, 
            response: responseText.substring(0, 200) 
          },
        };
      } else {
        return {
          success: false,
          message: `Profile update API returned ${updateResponse.status}`,
          details: { 
            status: updateResponse.status, 
            body: responseText.substring(0, 500) 
          },
        };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      logger.error('naukri worker failed', { error: message, stack });
      return {
        success: false,
        message: 'Failed to update Naukri profile',
        details: { error: message },
      };
    }
  }

  /**
   * Login to Naukri via their internal API and extract the JWT access token.
   */
  private async loginViaApi(email: string, password: string, logger: ExecutionContext['logger']): Promise<string | null> {
    try {
      const loginResponse = await globalThis.fetch(
        'https://www.naukri.com/central-login-services/v1/login',
        {
          method: 'POST',
          headers: {
            'accept': 'application/json',
            'content-type': 'application/json',
            'appid': '105',
            'systemid': 'Naukri',
            'clientid': 'd3skt0p',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
            'origin': 'https://www.naukri.com',
            'referer': 'https://www.naukri.com/nlogin/login',
          },
          body: JSON.stringify({ username: email, password }),
        }
      );

      logger.info('login API response status', { status: loginResponse.status });

      if (!loginResponse.ok) {
        const errorBody = await loginResponse.text();
        logger.error('login API failed', { status: loginResponse.status, body: errorBody.substring(0, 500) });
        return null;
      }

      // Try to get the token from the response body
      const data = await loginResponse.json() as Record<string, unknown>;
      logger.info('login response keys', { keys: Object.keys(data) });
      
      // Naukri login API typically returns the token in one of these fields
      const token = (data.token || data.accessToken || data.access_token) as string | undefined;
      
      if (token) {
        logger.info('extracted token from login response body');
        return token;
      }

      // Fallback: check Set-Cookie headers for nauk_at
      const setCookieHeader = loginResponse.headers.get('set-cookie');
      if (setCookieHeader) {
        const match = setCookieHeader.match(/nauk_at=([^;]+)/);
        if (match?.[1]) {
          logger.info('extracted token from Set-Cookie header');
          return match[1];
        }
      }

      // Last resort: log what we got so user can help debug
      logger.warn('could not find token in login response', { 
        responsePreview: JSON.stringify(data).substring(0, 500)
      });
      return null;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('login API error', { error: message });
      return null;
    }
  }
}
