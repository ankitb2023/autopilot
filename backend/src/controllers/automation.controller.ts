import type { Request, Response } from 'express';

import { automationService } from '../automation/automation.service';
import { describeProviders } from '../automation/provider.registry';
import { sendSuccess } from '../core/httpResponse';
import { validatedBody } from '../middleware/validate';
import { updateProfileBodySchema } from '../validation/automation.schema';

/**
 * HTTP adapter for the automation engine.
 *
 * Contains no automation logic and — critically — no provider names. Its entire
 * job is: read validated input, name the action, call the service, serialise the
 * result. Adding LinkedIn requires zero changes to this file, which is the
 * property the brief asks for.
 *
 * Errors are never caught here; they propagate to the centralized handler.
 */

/** POST /api/profile/update */
export async function updateProfile(req: Request, res: Response): Promise<void> {
  const { provider, trigger, dryRun } = validatedBody(req, updateProfileBodySchema);

  const result = await automationService.execute({
    provider,
    // The only provider-agnostic knowledge this route contributes.
    action: 'profile.update',
    trigger,
    dryRun,
  });

  // 200 even for a reported failure: the *request* succeeded and the envelope
  // carries the automation's own status. Genuine breakage throws and is mapped to
  // 5xx by the error handler, so callers can still distinguish the two.
  sendSuccess(res, result);
}

/**
 * GET /api/providers
 *
 * Capability discovery. Lets the dashboard and mobile app render available
 * automations from the registry instead of shipping a duplicated hardcoded list.
 */
export function listProviders(_req: Request, res: Response): void {
  sendSuccess(res, { providers: describeProviders() });
}
