import type {
  AutomationAction,
  AutomationWorker,
  ExecutionContext,
  ProviderId,
  WorkerOutcome,
} from '../types';
import { env } from '../../config/env';
import { prisma } from '../../config/prisma';

/**
 * Naukri automation worker — Direct API approach.
 * 
 * Uses a stored JWT token (obtained via the /api/auth MFA flow) to call
 * Naukri's profile update API directly. No browser needed.
 */
export class NaukriWorker implements AutomationWorker {
  readonly provider: ProviderId = 'naukri';
  readonly supportedActions: readonly AutomationAction[] = ['profile.update'];

  async execute({ logger, dryRun, signal }: ExecutionContext): Promise<WorkerOutcome> {
    logger.info('naukri worker starting (API mode)', { dryRun });
    signal.throwIfAborted();

    try {
      // ── Step 1: Get a valid token from the database ──────────────────
      const storedToken = await prisma.naukriToken.findFirst({
        where: { expiresAt: { gt: new Date() } },
        orderBy: { expiresAt: 'desc' },
      });

      if (!storedToken) {
        return {
          success: false,
          message: 'No valid Naukri token found. Please authenticate first via POST /api/auth/init-login → POST /api/auth/verify-otp.',
          details: {},
        };
      }

      const minutesRemaining = Math.round((storedToken.expiresAt.getTime() - Date.now()) / 60000);
      logger.info('using stored token', { expiresAt: storedToken.expiresAt.toISOString(), minutesRemaining });

      if (minutesRemaining < 5) {
        logger.warn('token is about to expire, update may fail');
      }

      signal.throwIfAborted();

      if (dryRun) {
        logger.info('dry run: skipping actual profile update');
        return { success: true, message: 'Dry run completed — valid token found.', details: { dryRun: true, minutesRemaining } };
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
            'authorization': `Bearer ${storedToken.accessToken}`,
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
}
