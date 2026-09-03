// Collector: wires config -> transport -> session manager, and builds the
// signed preamble (session.started, dependency.snapshot, collector.report).
//
// NOTE: the dependency snapshot and coverage report here are minimal (milestone
// 1). Milestone 4 enriches them (full lockfile-derived package list, enabled
// patches/adapters, live counters). The event SHAPES and ordering are stable.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { AerAutoConfig, Principal } from './config.js';
import { createHttpTransport } from './transport.js';
import {
  createSessionManager,
  type SessionManager,
  type CollectorEvent,
  type SessionTransport,
} from './session.js';
import { installTransportPatches, type InstalledPatches } from './patches/index.js';
import { installAdapters, type InstalledAdapters, type AdapterStats, type PolicyOption, type CommitOption } from './adapters/index.js';
import { commitmentKeyFromString, deriveKid } from './commitment.js';
import { buildDependencySnapshot } from './dependencies/snapshot.js';
import { createAttestor, type Attestor } from './attestor.js';
import { PolicyEnforcer } from './policy.js';
import { fetchUsagePolicy } from './policy-fetch.js';

export const COLLECTOR_NAME = '@adastracomputing/aer-auto-node';
export const COLLECTOR_VERSION = '0.3.0'; // keep in sync with package.json
// Event-schema contract this collector build speaks. Declared at session create
// so collector/API version skew is explicit rather than inferred at ingest.
export const SCHEMA_CAPABILITY = 'aer-events.v1';

/** Per-task identity overrides for withSession (server/task strategies). */
export interface WithSessionOpts {
  agentId?: string;
  tenantId?: string;
  envId?: string;
  baseUrl?: string;
  /** Identity this task's session runs on behalf of (P1). Overrides the
   *  process-wide AER_PRINCIPAL_* configuration for this session only. */
  principal?: Principal;
}

export interface Collector {
  config: AerAutoConfig;
  /** The default (process-strategy) session manager. */
  session: SessionManager;
  capture(event: CollectorEvent): void;
  /** Attestation token for `audience` (+ optional `scopes`, `dpop` binding) on the current session, or null. */
  getAttestationFor(audience: string, scopes?: string[], dpop?: boolean): Promise<string | null>;
  /** Synchronous cached-token read for `audience` (+ `scopes`, `dpop`), no mint, or null. */
  peekAttestationFor(audience: string, scopes?: string[], dpop?: boolean): string | null;
  complete(): Promise<void>;
  abort(): Promise<void>;
  /** Run `fn` inside a fresh AER session (task/server strategies + escape hatch). */
  withSession<T>(opts: WithSessionOpts, fn: () => T | Promise<T>): Promise<T>;
  /** Remove all installed transport patches + SDK adapters. */
  uninstall(): void;
  /** Active patch names (also reflected in collector.report). */
  enabledPatches: readonly string[];
  /** Active SDK adapter names (also reflected in collector.report). */
  enabledAdapters: readonly string[];
}

export interface CreateCollectorDeps {
  /** Inject the DEFAULT session's transport (tests); otherwise built from config. */
  transport?: SessionTransport;
  onError?: (err: unknown, ctx: string) => void;
  /**
   * Build a fresh transport for each `withSession` task. Defaults to an HTTP
   * transport built from config (merged with per-task overrides). Tests inject
   * a factory returning fake transports.
   */
  sessionTransportFactory?: (opts: WithSessionOpts) => SessionTransport;
  /**
   * Override patch installation. Defaults to installing the real global
   * transport patches. Tests pass a fake (or `false`) to avoid mutating globals.
   */
  patchInstaller?: ((capture: (e: CollectorEvent) => void, transports: string[], attestor?: Attestor) => InstalledPatches) | false;
  /**
   * Override SDK adapter installation. Defaults to detecting + patching
   * installed SDKs. Tests pass `false` to avoid touching real modules.
   */
  adapterInstaller?: ((capture: (e: CollectorEvent) => void, adapters: string[], policy?: PolicyOption | (() => PolicyOption | undefined), commit?: CommitOption) => InstalledAdapters) | false;
  /**
   * Fetch the governing usage policy for a session (P3 slice 2). Defaults to the
   * best-effort HTTP fetch over the pristine fetch. Tests inject a fake to
   * exercise enforcement / fail-open without the network. Returns null =>
   * enforcement disabled for that session.
   */
  policyFetcher?: (opts: { baseUrl: string; agentId?: string | undefined; apiKey?: string | undefined }) => Promise<import('./policy.js').UsagePolicy | null>;
}

export function createCollector(config: AerAutoConfig, deps: CreateCollectorDeps = {}): Collector {
  const enabledPatches: string[] = [];
  const enabledAdapters: string[] = [];
  let adapterStats: AdapterStats | undefined;
  const onError = deps.onError ?? defaultOnError;

  // Snapshot the pristine global fetch BEFORE the transport patches install
  // (below). The collector's OWN wire traffic must never be re-instrumented: the
  // default process transport is built pre-patch, but withSession transports are
  // built lazily AFTER patching and would otherwise capture the patched fetch -
  // a self-instrumentation feedback loop (emit -> http.requested -> emit -> …).
  // Prefer the fetch patch's stashed original in case a prior collector patched.
  const stashedOriginalFetch = (globalThis as Record<symbol, unknown>)[Symbol.for('adastra.aer.original.fetch')];
  const rawFetch = typeof stashedOriginalFetch === 'function'
    ? (stashedOriginalFetch as typeof fetch)
    : globalThis.fetch;
  const pristineFetch: typeof fetch | undefined =
    typeof rawFetch === 'function' ? (rawFetch.bind(globalThis) as typeof fetch) : undefined;

  // Per-session usage-policy state (P3 slice 2). Each session gets its own
  // enforcer with independent call/token counters, populated once its policy
  // fetch resolves. Keyed by SessionManager so the adapter's PolicyOption
  // resolver (below) can find the enforcer for the current async context.
  interface PerSessionPolicy { enforcer: PolicyEnforcer }
  const sessionPolicy = new WeakMap<SessionManager, PerSessionPolicy>();
  const policyFetcher = deps.policyFetcher
    ?? ((o: { baseUrl: string; agentId?: string | undefined; apiKey?: string | undefined }) =>
      fetchUsagePolicy({ ...o, ...(pristineFetch ? { fetchImpl: pristineFetch } : {}) }));

  // Build a SessionManager around a transport (used for both the default
  // process session and each per-task session). Each session emits its own
  // preamble (session.started / dependency.snapshot / collector.report).
  const makeSession = (transport: SessionTransport, eager: boolean, opts: WithSessionOpts = {}): SessionManager => {
    const session = createSessionManager({
      transport,
      eager,
      preamble: () => buildPreamble(config, enabledPatches, enabledAdapters),
      closingReport: () => buildCollectorReport(config, 'final', enabledPatches, enabledAdapters, attestor, adapterStats),
      onError,
    });
    // Enforcer starts disabled (null) so any LLM call before the policy fetch
    // resolves is simply ungated (best-effort, never blocks session open).
    const state: PerSessionPolicy = { enforcer: new PolicyEnforcer(null) };
    sessionPolicy.set(session, state);
    // Best-effort policy fetch. On any failure => enforcer stays disabled
    // (fail-open). When an active policy lands, emit ONE policy.applied event so
    // the bundle records which policy governed the run.
    const agentId = opts.agentId ?? config.agentId;
    void policyFetcher({ baseUrl: opts.baseUrl ?? config.baseUrl, agentId, ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}) })
      .then((policy) => {
        if (!policy) return;
        const enforcer = new PolicyEnforcer(policy);
        state.enforcer = enforcer;
        if (enforcer.active) {
          session.capture({
            event_type: 'policy.applied',
            payload: { policy_id: enforcer.policyId, version: enforcer.version, mode: enforcer.mode },
          });
        }
      })
      .catch((err) => onError(err, 'policy-fetch'));
    return session;
  };

  // Resolve the PolicyOption for the current async context: the enforcer of the
  // session that owns this LLM call, plus an emit that routes policy events to
  // that same session. Returns undefined when there is no active session.
  const currentPolicyOption = (): PolicyOption | undefined => {
    const s = currentSession();
    if (!s) return undefined;
    const state = sessionPolicy.get(s);
    if (!state) return undefined;
    return {
      enforcer: state.enforcer,
      emit: (eventType, payload) => { s.capture({ event_type: eventType, payload }); },
    };
  };

  const buildTransport = (opts: WithSessionOpts = {}): SessionTransport => {
    const tenantId = opts.tenantId ?? config.tenantId;
    const agentId = opts.agentId ?? config.agentId;
    const envId = opts.envId ?? config.envId;
    const principal = opts.principal ?? config.principal;
    return createHttpTransport({
      baseUrl: opts.baseUrl ?? config.baseUrl,
      ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
      ...(tenantId !== undefined ? { tenantId } : {}),
      ...(agentId !== undefined ? { agentId } : {}),
      ...(envId !== undefined ? { envId } : {}),
      ...(principal !== undefined ? { principal } : {}),
      agentVersion: config.agentVersion,
      // Declare this collector's identity + event-schema capability so the API
      // records version skew explicitly (capability negotiation).
      collector: { name: COLLECTOR_NAME, version: COLLECTOR_VERSION, schema_capability: SCHEMA_CAPABILITY },
      // Always send over the pristine fetch so the collector never instruments
      // its own traffic (matters for withSession transports built post-patch).
      ...(pristineFetch ? { fetchImpl: pristineFetch } : {}),
    });
  };
  const transportFactory = deps.sessionTransportFactory ?? buildTransport;

  // Default (process-strategy) session, created lazily on first need.
  const defaultTransport = deps.transport ?? buildTransport();
  let defaultSession: SessionManager | null = null;
  const getDefault = (): SessionManager => {
    if (!defaultSession) defaultSession = makeSession(defaultTransport, config.session.eager);
    return defaultSession;
  };

  // AsyncLocalStorage holds the active per-task session (task/server strategies).
  const als = new AsyncLocalStorage<SessionManager>();

  // Route a captured event to the session that owns the current async context.
  function currentSession(): SessionManager | null {
    const ctx = als.getStore();
    if (ctx) return ctx;
    // No task context: server never has an implicit session; task with
    // requireTask drops; otherwise fall back to the default process session.
    if (config.session.strategy === 'server') return null;
    if (config.session.strategy === 'task' && config.session.requireTask) return null;
    return getDefault();
  }

  const capture = (e: CollectorEvent): void => {
    const s = currentSession();
    if (s) s.capture(e);
  };

  const getAttestationFor = (audience: string, scopes: string[] = [], dpop = false): Promise<string | null> => {
    const s = currentSession();
    return s ? s.getAttestationFor(audience, scopes, dpop) : Promise.resolve(null);
  };

  const peekAttestationFor = (audience: string, scopes: string[] = [], dpop = false): string | null => {
    const s = currentSession();
    return s ? s.peekAttestationFor(audience, scopes, dpop) : null;
  };

  const dpopProofFor = (method: string, url: string, token: string): string | null => {
    const s = currentSession();
    return s ? s.dpopProofFor(method, url, token) : null;
  };

  // Attestation injector for the transport patches: only built when protected
  // resources are configured, so the no-attestation path stays zero-overhead.
  const attestor: Attestor | undefined = config.protectedResources.length > 0
    ? createAttestor({ resources: config.protectedResources, getAttestationFor, peekAttestationFor, dpopProofFor })
    : undefined;

  async function withSession<T>(opts: WithSessionOpts, fn: () => T | Promise<T>): Promise<T> {
    const session = makeSession(transportFactory(opts), false, opts);
    return als.run(session, async () => {
      try {
        const result = await fn();
        await session.complete();
        return result;
      } catch (err) {
        await session.abort();
        throw err;
      }
    });
  }

  const teardowns: Array<() => void> = [];
  if (deps.patchInstaller !== false) {
    const installer = typeof deps.patchInstaller === 'function' ? deps.patchInstaller : installTransportPatches;
    const installed = installer(capture, config.capture.transport, attestor);
    enabledPatches.push(...installed.enabled);
    teardowns.push(installed.uninstall);
  }
  // Content-commitment option (ADR-011): parse the customer key once. When it is
  // absent or too short, `commit` stays undefined and NO commitments are emitted
  // (no bare-hash fallback - an unkeyed tag would be a brute-force oracle).
  let commit: CommitOption | undefined;
  const commitKey = commitmentKeyFromString(config.commitmentKey);
  if (commitKey) commit = { key: commitKey, kid: deriveKid(commitKey) };

  if (deps.adapterInstaller !== false) {
    const installer = typeof deps.adapterInstaller === 'function'
      ? deps.adapterInstaller
      : (c: (e: CollectorEvent) => void, a: string[], p?: PolicyOption | (() => PolicyOption | undefined), cm?: CommitOption) => installAdapters(c, a, {}, p, cm);
    // Pass the resolver (not a fixed option): each LLM call is gated by the
    // enforcer of the session that owns its async context.
    const installed = installer(capture, config.capture.adapters, currentPolicyOption, commit);
    enabledAdapters.push(...installed.enabled);
    adapterStats = installed.stats;
    teardowns.push(installed.uninstall);
  }

  // Eager prewarm: when protected resources are configured on
  // the process strategy, warm the token cache so the FIRST node:http request to
  // a protected host carries a token too (fetch is always awaited, so covered
  // regardless). Best-effort; deferred a tick so bootstrap finishes installing.
  if (attestor && config.session.strategy === 'process') {
    // Dedupe by resource (audience + dpop binding); warm with that resource's
    // configured scopes so the prewarmed token matches what the request path asks
    // for, including DPoP-bound (cnf) vs bearer tokens.
    const seen = new Set<string>();
    const toWarm: Array<{ audience: string; scopes: string[]; dpop: boolean }> = [];
    for (const r of config.protectedResources) {
      const key = `${r.audience}|${r.dpop ? 'd' : 'b'}`;
      if (!seen.has(key)) { seen.add(key); toWarm.push({ audience: r.audience, scopes: r.scopes, dpop: r.dpop }); }
    }
    queueMicrotask(() => {
      for (const w of toWarm) void getAttestationFor(w.audience, w.scopes, w.dpop).catch(() => undefined);
    });
  }

  return {
    config,
    get session() { return getDefault(); },
    capture,
    getAttestationFor,
    peekAttestationFor,
    withSession,
    // Lifecycle hooks call these on process exit - only the default session
    // needs closing (per-task sessions complete/abort inside withSession).
    complete: () => defaultSession ? defaultSession.complete() : Promise.resolve(),
    abort: () => defaultSession ? defaultSession.abort() : Promise.resolve(),
    uninstall: () => { for (const t of teardowns) { try { t(); } catch { /* ignore */ } } },
    enabledPatches,
    enabledAdapters,
  };
}

function buildPreamble(
  config: AerAutoConfig,
  enabledPatches: readonly string[],
  enabledAdapters: readonly string[],
): CollectorEvent[] {
  return [
    {
      event_type: 'session.started',
      payload: { agent: config.agentId ?? 'unknown', collector: COLLECTOR_NAME },
    },
    dependencySnapshotEvent(),
    buildCollectorReport(config, 'open', enabledPatches, enabledAdapters),
  ];
}

function dependencySnapshotEvent(): CollectorEvent {
  // Resolves declared deps to installed versions + lockfile hash (snapshot.ts).
  return {
    event_type: 'dependency.snapshot',
    payload: { ...buildDependencySnapshot() },
  };
}

function buildCollectorReport(
  config: AerAutoConfig,
  phase: 'open' | 'final',
  enabledPatches: readonly string[],
  enabledAdapters: readonly string[],
  attestor?: Attestor,
  adapterStats?: AdapterStats,
): CollectorEvent {
  return {
    event_type: 'collector.report',
    payload: {
      collector: COLLECTOR_NAME,
      version: COLLECTOR_VERSION,
      phase,
      runtime: 'node',
      node_version: process.versions.node,
      session_strategy: config.session.strategy,
      enabled_patches: [...enabledPatches],
      // Adapters actually detected + patched (not just configured).
      enabled_adapters: [...enabledAdapters],
      capture_policy: {
        headers: config.capture.headers ? 'on' : 'off',
        bodies: config.capture.bodies ? 'on' : 'off',
        query_strings: config.capture.redact_query ? 'redacted' : 'on',
        args: config.capture.redact_args ? 'redacted' : 'on',
      },
      // Attestation injection coverage (2b); only present when protected
      // resources are configured. `final` phase carries the live counters.
      ...(attestor
        ? {
            attestation: {
              protected_resources: config.protectedResources.map((r) => r.host),
              // Per-resource enforcement so the report shows which hosts can block.
              enforcement: config.protectedResources.map((r) => ({ host: r.host, mode: r.enforcement })),
              injected: attestor.stats.injected,
              cache_miss: attestor.stats.cache_miss,
              warm_failed: attestor.stats.warm_failed,
              redirect_cross_origin_stripped: attestor.stats.redirect_cross_origin_stripped,
              redirect_manual_fallback: attestor.stats.redirect_manual_fallback,
              // Egress enforcement counters (M2).
              egress_blocked: attestor.stats.egress_blocked,
              egress_would_block: attestor.stats.egress_would_block,
              egress_unavailable_fail_open: attestor.stats.egress_unavailable_fail_open,
              egress_insufficient_scope: attestor.stats.egress_insufficient_scope,
            },
          }
        : {}),
      // Per-provider SDK adapter activity (calls/ok/error/tool_selections);
      // only on the `final` report and only for adapters that actually ran.
      ...(adapterStats && !adapterStats.empty
        ? { adapter_activity: adapterStats.snapshot() }
        : {}),
    },
  };
}

function defaultOnError(err: unknown, ctx: string): void {
  // Never throw into the host; one structured line per failure.
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[aer:auto] ${ctx} failed: ${msg}`);
}
