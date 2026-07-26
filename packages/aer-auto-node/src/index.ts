// Programmatic API for the AER auto-instrumentation collector.
//
// Most users never import this — they load `@adastracomputing/aer-auto-node/register`
// and the collector wires itself in. This surface is for advanced control and
// the manual escape hatch.

export { resolveConfig, resolvePrincipal } from './config.js';
export type {
  AerAutoConfig,
  SessionConfig,
  CaptureConfig,
  SessionStrategy,
  ResolveOptions,
  Principal,
  PrincipalKind,
} from './config.js';

export { createDpopKey, normalizeHtu as normalizeDpopHtu } from './dpop.js';
export type { DpopKey, DpopProofArgs } from './dpop.js';

export { createSessionManager } from './session.js';
export type {
  SessionManager,
  SessionTransport,
  SessionState,
  CollectorEvent,
  SeverityHint,
} from './session.js';

export { createHttpTransport } from './transport.js';
export type { HttpTransportOptions } from './transport.js';

export { createCollector, COLLECTOR_NAME, COLLECTOR_VERSION } from './collector.js';
export type { Collector, WithSessionOpts } from './collector.js';

// Usage-policy enforcement (P3 slice 2). AerPolicyError is thrown by the wrapped
// LLM create in block mode before the SDK call; the types describe the policy the
// collector fetches and enforces. matchModel + PolicyEnforcer are exported for
// tests / advanced use.
export { AerPolicyError, PolicyEnforcer, matchModel } from './policy.js';
export type { UsagePolicy, PolicyMode, PolicyViolation, PolicyRule } from './policy.js';

export { bootstrap, installLifecycleHooks, isConfigured } from './bootstrap.js';
export { getActiveCollector, setActiveCollector } from './state.js';

import type { CollectorEvent, SessionManager } from './session.js';
import type { WithSessionOpts } from './collector.js';
import { getActiveCollector } from './state.js';

/**
 * Manual escape hatch: record an event on the active session. No-op (returns
 * false) when the collector isn't running (disabled / unconfigured). Auto-capture
 * is the norm; reach for this only for things the patches/adapters can't see.
 */
export function captureEvent(event: CollectorEvent): boolean {
  const collector = getActiveCollector();
  if (!collector) return false;
  collector.capture(event);
  return true;
}

/** The active session manager, or null when the collector isn't running. */
export function getActiveSession(): SessionManager | null {
  return getActiveCollector()?.session ?? null;
}

/**
 * Run `fn` inside a dedicated AER session. The escape hatch for long-running
 * servers / `server` and `task` strategies: each call opens a fresh session,
 * captures everything done inside (across awaits, via AsyncLocalStorage), and
 * completes it when `fn` resolves (or aborts if it throws). When the collector
 * isn't running (disabled / unconfigured), `fn` simply runs uninstrumented.
 */
export function withAerSession<T>(
  opts: WithSessionOpts,
  fn: () => T | Promise<T>,
): Promise<T> {
  const collector = getActiveCollector();
  if (!collector) return Promise.resolve().then(fn);
  return collector.withSession(opts, fn);
}
