import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Ambient correlation data for the current unit of work.
 *
 * Carried in AsyncLocalStorage rather than threaded through every function
 * signature. The logger reads it automatically, so any log line emitted during
 * a request or an automation run is attributable without extra plumbing.
 *
 * Phase 9 (WebSocket live logs) routes log lines to subscribers by `executionId`
 * — which is precisely why it lives here instead of inside the worker.
 */
export interface RequestContext {
  requestId: string;
  executionId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with the given context bound to the async execution tree. */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Attaches values to the *current* context, if one exists.
 *
 * Mutating the active store is intentional: the execution ID is minted after
 * the request context is established, and every log line downstream — including
 * ones emitted by code that already captured the store — should see it.
 */
export function setContextValues(values: Partial<RequestContext>): void {
  const store = storage.getStore();
  if (!store) return;
  Object.assign(store, values);
}
