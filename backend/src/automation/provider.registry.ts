import { ProviderNotSupportedError } from '../core/errors';
import { NaukriWorker } from './workers/naukri.worker';
import type { AutomationAction, AutomationWorker, ProviderId, WorkerFactory } from './types';

/**
 * Provider factory, implemented as a registry.
 *
 * Why not `switch (provider)`:
 *   1. Adding LinkedIn is one new file plus one line here — no controller, route,
 *      service or validation change.
 *   2. The supported set becomes *data*, so request validation and the factory
 *      read from one source and cannot drift apart.
 *
 * `Partial<Record<...>>` is the load-bearing detail: the key space is the whole
 * provider vocabulary, and only implemented entries are present.
 */
const registry: Partial<Record<ProviderId, WorkerFactory>> = {
  naukri: () => new NaukriWorker(),

  // Phase 3+ — one line each once the worker file exists:
  // linkedin: () => new LinkedInWorker(),
  // github: () => new GitHubWorker(),
};

/** Providers that actually have a worker behind them. */
export function getSupportedProviders(): ProviderId[] {
  return (Object.keys(registry) as ProviderId[]).sort();
}

/**
 * Resolves a worker for a provider. Throws (→ 400, listing what *is* available)
 * rather than returning null, so no call site has to re-handle the unknown case.
 */
export function createWorker(provider: ProviderId): AutomationWorker {
  const factory = registry[provider];
  if (!factory) {
    throw new ProviderNotSupportedError(provider, getSupportedProviders());
  }
  return factory();
}

/** Registry introspection for the discovery endpoint. */
export function describeProviders(): Array<{
  provider: ProviderId;
  supportedActions: readonly AutomationAction[];
}> {
  return getSupportedProviders().map((provider) => ({
    provider,
    supportedActions: createWorker(provider).supportedActions,
  }));
}
