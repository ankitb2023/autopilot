import { z } from 'zod';

import { getSupportedProviders } from '../automation/provider.registry';
import { TRIGGER_SOURCES, type ProviderId } from '../automation/types';

/**
 * The provider enum is derived from the registry, not hand-listed. That is what
 * guarantees validation and the factory can never disagree: register a worker and
 * the API accepts it; remove one and the API rejects it, naming the alternatives.
 */
const supported = getSupportedProviders();

if (supported.length === 0) {
  throw new Error('No automation providers are registered.');
}

export const updateProfileSchema = z
  .object({
    provider: z.enum(supported as [ProviderId, ...ProviderId[]]),

    /** GitHub Actions sends CRON so scheduled runs are distinguishable. */
    trigger: z.enum(TRIGGER_SOURCES).default('API'),

    /** Exercise the pipeline without mutating the remote profile. */
    dryRun: z.boolean().default(false),
  })
  .strict(); // A typo'd field should fail loudly, not be silently ignored.
