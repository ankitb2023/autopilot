import type { Request, Response } from 'express';

import { executeAutomation } from '../automation/automation.service';
import { describeProviders } from '../automation/provider.registry';
import { updateProfileSchema } from '../validation/automation.schema';

/**
 * HTTP adapter for the automation engine.
 *
 * No automation logic and — critically — no provider names. It reads input, names
 * the action, calls the service, returns the result. Adding LinkedIn requires zero
 * changes to this file.
 *
 * Errors are not caught here; Zod and AppError both propagate to the error handler.
 */

/** POST /api/profile/update */
export async function updateProfile(req: Request, res: Response): Promise<void> {
  const { provider, trigger, dryRun } = updateProfileSchema.parse(req.body);

  const result = await executeAutomation({
    provider,
    // The only action-specific knowledge this route contributes.
    action: 'profile.update',
    trigger,
    dryRun,
  });

  // 200 even when the automation reports failure: the *request* succeeded, and
  // `status` carries the automation's own outcome. Real breakage throws and is
  // mapped to 5xx, so callers can still tell the two apart.
  res.json(result);
}

/** GET /api/providers — so a dashboard never hardcodes a provider list. */
export function listProviders(_req: Request, res: Response): void {
  res.json({ providers: describeProviders() });
}
