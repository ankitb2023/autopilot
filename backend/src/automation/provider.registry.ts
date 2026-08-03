import { ProviderNotSupportedError } from '../core/errors';
import { NaukriWorker } from './workers/naukri.worker';
import type { AutomationAction, AutomationWorker, ProviderId, WorkerFactory } from './types';

/**
 * Provider factory, implemented as a registry.
 *
 * Why a registry rather than `switch (provider)`:
 *
 *  1. Adding LinkedIn is one new file plus one line here. No controller, route,
 *     service or validation schema changes — the property the brief asks for.
 *  2. The set of supported providers becomes *data*, so request validation and
 *     the factory read from the same source and cannot drift apart.
 *  3. `/api/providers` can advertise capabilities to the dashboard and mobile
 *     app without a hand-maintained second list.
 *
 * `Partial<Record<...>>` is the load-bearing detail: the key space is the whole
 * provider vocabulary, and only implemented entries are present.
 */
const registry: Partial<Record<ProviderId, WorkerFactory>> = {
  naukri: () => new NaukriWorker(),

  // Phase 3+ — each is a single line once its worker file exists:
  // linkedin: () => new LinkedInWorker(),
  // github: () => new GitHubWorker(),
  // indeed: () => new IndeedWorker(),
};

/** Providers that actually have a worker behind them, sorted for stable output. */
export function getSupportedProviders(): ProviderId[] {
  return (Object.keys(registry) as ProviderId[]).sort();
}

export function isProviderSupported(provider: string): provider is ProviderId {
  return Object.hasOwn(registry, provider);
}

/**
 * Resolves a worker instance for a provider.
 *
 * Throws `ProviderNotSupportedError` (→ 400, listing what *is* available) rather
 * than returning null: an unknown provider is a caller error, and forcing every
 * call site to re-handle it would duplicate that decision.
 */
export function createWorker(provider: ProviderId): AutomationWorker {
  const factory = registry[provider];

  if (!factory) {
    throw new ProviderNotSupportedError(provider, getSupportedProviders());
  }

  return factory();
}

export interface ProviderCapability {
  provider: ProviderId;
  supportedActions: readonly AutomationAction[];
}

/**
 * Introspects the registry for the discovery endpoint.
 *
 * Instantiates each worker to read its declared actions. Cheap today; if a
 * future worker's constructor becomes expensive, `supportedActions` moves to a
 * static descriptor on the registry entry.
 */
export function describeProviders(): ProviderCapability[] {
  return getSupportedProviders().map((provider) => {
    const worker = createWorker(provider);
    return { provider, supportedActions: worker.supportedActions };
  });
}
