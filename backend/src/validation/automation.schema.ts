import { z } from 'zod';

import { getSupportedProviders } from '../automation/provider.registry';
import {
  ACCOUNT_ID_PATTERN,
  DEFAULT_ACCOUNT,
  TRIGGER_SOURCES,
  type ProviderId,
} from '../automation/types';

/**
 * The provider enum is derived from the registry, not hand-listed. That is what
 * guarantees validation and the factory can never disagree: register a worker and
 * the API accepts it; remove one and the API rejects it, naming the alternatives.
 */
const supported = getSupportedProviders();

/** Lowercase slug, so it is safe in a lock key, a log line and a URL. */
export const accountSchema = z
  .string()
  .regex(ACCOUNT_ID_PATTERN, 'account must be a lowercase slug (a-z, 0-9, _ or -)')
  .default(DEFAULT_ACCOUNT);

if (supported.length === 0) {
  throw new Error('No automation providers are registered.');
}

export const updateProfileSchema = z
  .object({
    provider: z.enum(supported as [ProviderId, ...ProviderId[]]),

    /** Which of the provider's accounts to update; omitted means `default`. */
    account: accountSchema,

    /** GitHub Actions sends CRON so scheduled runs are distinguishable. */
    trigger: z.enum(TRIGGER_SOURCES).default('API'),

    /** Exercise the pipeline without mutating the remote profile. */
    dryRun: z.boolean().default(false),
  })
  .strict(); // A typo'd field should fail loudly, not be silently ignored.
