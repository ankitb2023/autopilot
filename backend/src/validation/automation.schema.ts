import { z } from 'zod';

import { getSupportedProviders } from '../automation/provider.registry';
import { TRIGGER_SOURCES, type ProviderId } from '../automation/types';

/**
 * Request validation for the automation endpoints.
 *
 * The provider enum is derived from the registry at module load, not hand-listed.
 * That is what guarantees validation and the factory can never disagree: register
 * a worker and the API accepts it; remove one and the API rejects it with an
 * accurate list of alternatives.
 */
function providerEnum() {
  const supported = getSupportedProviders();

  /* istanbul ignore next — unreachable unless the registry is emptied. */
  if (supported.length === 0) {
    throw new Error('No automation providers are registered.');
  }

  return z.enum(supported as [ProviderId, ...ProviderId[]]);
}

export const updateProfileBodySchema = z
  .object({
    provider: providerEnum(),

    /**
     * Defaults to API. GitHub Actions (Phase 2) sends `CRON` so scheduled runs
     * are distinguishable in history and can carry a different alerting policy.
     */
    trigger: z.enum(TRIGGER_SOURCES).default('API'),

    /** Exercise the pipeline without mutating the remote profile. */
    dryRun: z.boolean().default(false),
  })
  .strict(); // Reject unknown keys — a typo'd field should fail loudly, not silently.

export type UpdateProfileBody = z.infer<typeof updateProfileBodySchema>;
