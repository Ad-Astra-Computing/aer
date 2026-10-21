// Session lifecycle core for the auto-instrumentation collector.
//
// Process strategy: patches install immediately (elsewhere); the session opens
// lazily on the first captured event. On open, the fixed preamble order is
//   session.started -> dependency.snapshot -> collector.report -> triggering event
// (the preamble is injected so this module stays decoupled from snapshot/coverage
// detail). Completion flushes, emits a closing report, then completes the AER.
//
// Invariants: never throw into the host; open at most once; complete/abort are
// idempotent; an idle (event-free) session is never created.

import { createDpopKey, type DpopKey } from './dpop.js';

export type SeverityHint = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface CollectorEvent {
  event_type: string;
  payload: Record<string, unknown>;
  severity_hint?: SeverityHint;
}

/**
 * Thrown by a transport (see transport.ts's createHttpTransport) in place of a
 * generic Error when the AER API refuses a request with one of its two
 * structured 403 bodies: the tenant's usage cap was reached, or this agent is
 * paused by the tenant operator. Carries a clear, plain-English message (never
 * the raw JSON body) plus the fields the session manager needs to back off
 * instead of hammering the API on every subsequent batch.
 *
 * Defined here, not in transport.ts, to avoid an import cycle: transport.ts
 * already imports CollectorEvent/SessionTransport from this module, so a
 * transport importing this class back from here (as transport.ts does, via
 * its re-export) keeps the dependency running only one way.
 */
export class AerRefusalError extends Error {
  readonly kind: 'usage_limit_reached' | 'agent_paused';
  readonly recheckAfterSeconds: number;

  constructor(kind: 'usage_limit_reached' | 'agent_paused', recheckAfterSeconds: number, message: string) {
    super(message);
    this.name = 'AerRefusalError';
    this.kind = kind;
    this.recheckAfterSeconds = recheckAfterSeconds;
  }
}

export interface SessionTransport {
  /** Create the underlying AER session. */
  open(): Promise<void>;
  /** Send a batch of events (transport stamps ids/source_type/timestamps). */
  emit(events: CollectorEvent[]): Promise<void>;
  /** Close the session and generate the AER. */
  complete(): Promise<void>;
  /** Terminate the session without generating an AER (crash path). */
  abort(): Promise<void>;
  /**
   * Mint an attestation token for this session (2b). `dpopJkt` binds the token to
   * a DPoP key (M3). Omitted => unsupported.
   */
  mintAttestation?(audience: string, scopes?: string[], dpopJkt?: string): Promise<{ token: string; expiresAtMs: number }>;
}

export type SessionState = 'idle' | 'opening' | 'open' | 'closing' | 'closed';

/** What the session knows about its own delivery, for the closing report. */
export interface SessionDeliveryStats {
  /**
   * Events in batches the transport did not confirm (it threw or timed out).
   * A batch that timed out may still have reached the API, so this is an
   * upper bound on what the record lacks.
   */
  eventsDropped: number;
}

export interface SessionManagerDeps {
  transport: SessionTransport;
  /** Events emitted immediately after open, before any captured event. */
  preamble?: () => CollectorEvent[];
  /** Optional final coverage event emitted just before complete(). */
  closingReport?: (stats: SessionDeliveryStats) => CollectorEvent | null;
  /** Open on construction instead of on first event. */
  eager?: boolean;
  /** Internal-failure sink. Defaults to a no-op (never throws into the host). */
  onError?: (err: unknown, ctx: string) => void;
  /** Clock for attestation token freshness (ms). Defaults to Date.now. */
  now?: () => number;
  /** Factory for the per-session DPoP key (M3). Defaults to a real Ed25519 key. */
  dpopKeyFactory?: () => DpopKey;
}

export interface SessionManager {
  capture(event: CollectorEvent): void;
  flush(): Promise<void>;
  complete(): Promise<void>;
  abort(): Promise<void>;
  /**
   * Get a valid attestation token for `audience` (optionally requesting
   * `scopes`), minting + caching as needed (refreshes before expiry, dedupes
   * concurrent mints). The cache is keyed by audience + scopes so a low-scope
   * token can never satisfy a higher-scope request. Returns null when the
   * transport can't mint or the session is closed. Never throws.
   */
  getAttestationFor(audience: string, scopes?: string[], dpop?: boolean): Promise<string | null>;
  /**
   * Synchronous, side-effect-free read of a cached, non-stale token for
   * `audience` (+ `scopes`), or null. Does NOT mint (the sync http path uses
   * this; warming is the caller's job via getAttestationFor). Never throws.
   */
  peekAttestationFor(audience: string, scopes?: string[], dpop?: boolean): string | null;
  /**
   * Sign a DPoP proof for one request with the session's key (M3), or null if the
   * session is closed. Synchronous so the node:http path can attach it inline.
   */
  dpopProofFor(method: string, url: string, token: string): string | null;
  readonly state: SessionState;
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const { transport } = deps;
  const preamble = deps.preamble ?? (() => []);
  const onError = deps.onError ?? (() => undefined);

  const clock = deps.now ?? (() => Date.now());

  let state: SessionState = 'idle';
  const queue: CollectorEvent[] = [];
  let openPromise: Promise<void> | null = null;
  let draining: Promise<void> | null = null;
  let eventsDropped = 0;

  // Set when transport.emit refuses with AerRefusalError (usage cap reached or
  // agent paused): no further transport.emit calls are made until this time,
  // so a long-running session does not hammer the API on every drain while the
  // tenant is over its cap or the agent is paused. Cleared (by reaching it)
  // once the cooldown elapses, at which point the next attempt is a fresh
  // episode: if it refuses again, one new log line and one new cooldown.
  let refusedUntilMs: number | null = null;

  // Attestation token cache + concurrent-mint dedupe, per audience (2b).
  interface CachedToken { token: string; expiresAtMs: number; mintedAtMs: number }
  const tokenCache = new Map<string, CachedToken>();
  const tokenInflight = new Map<string, Promise<string | null>>();

  // Per-session DPoP key (M3), created lazily on first DPoP-enabled use.
  let dpopKey: DpopKey | null = null;
  function ensureDpopKey(): DpopKey {
    if (!dpopKey) dpopKey = (deps.dpopKeyFactory ?? createDpopKey)();
    return dpopKey;
  }

  function fail(err: unknown, ctx: string): void {
    try { onError(err, ctx); } catch { /* the error sink must never throw */ }
  }

  async function doOpen(): Promise<void> {
    try {
      await transport.open();
    } catch (err) {
      fail(err, 'open');
      if (err instanceof AerRefusalError) {
        // A refusal on open (most commonly agent_paused) is not a reason to
        // stop recording for the rest of the process: go back to idle with
        // the same cooldown gate capture() already honors for an emit
        // refusal, so the next capture() once the window elapses tries a
        // fresh episode instead of staying silent until restart.
        refusedUntilMs = clock() + err.recheckAfterSeconds * 1000;
        state = 'idle';
        queue.length = 0;
        openPromise = null;
        return;
      }
      state = 'closed';
      queue.length = 0;
      return;
    }
    let pre: CollectorEvent[] = [];
    try {
      pre = preamble();
      if (pre.length > 0) await transport.emit(pre);
    } catch (err) {
      eventsDropped += pre.length;
      fail(err, 'preamble');
    }
    state = 'open';
    await drain();
  }

  function ensureOpen(): Promise<void> {
    if (openPromise) return openPromise;
    state = 'opening';
    openPromise = doOpen();
    return openPromise;
  }

  /**
   * Send everything queued, including anything captured while a send was
   * already in flight.
   *
   * The guard used to return early when another drain held it, and the close
   * path called this same function, so an event captured mid-flush stayed in
   * the queue and the session closed without it. That is how a model call
   * that finished a moment before the close lost its completion.
   */
  async function drain(): Promise<void> {
    if (state !== 'open') return;
    // Join the in-flight send rather than returning: the caller needs to know
    // the queue is empty, not merely that somebody else is working on it.
    if (draining) {
      await draining;
      if (state !== 'open' || queue.length === 0) return;
    }
    if (queue.length === 0) return;

    draining = (async () => {
      // A failed batch is dropped rather than requeued, so this terminates.
      // The bound is belt and braces against a transport that captures.
      for (let pass = 0; pass < 64 && state === 'open' && queue.length > 0; pass++) {
        // A refusal cooldown still in effect: drop the rest of the queue
        // without calling transport.emit again, and without a second fail()
        // for the same episode. The operator already saw the one clear
        // message when the cooldown started.
        if (refusedUntilMs !== null) {
          if (clock() < refusedUntilMs) {
            eventsDropped += queue.length;
            queue.length = 0;
            break;
          }
          // Cooldown elapsed: the next attempt below is a fresh episode.
          refusedUntilMs = null;
        }
        const batch = queue.splice(0, queue.length);
        try {
          await transport.emit(batch);
        } catch (err) {
          // Never-throw: drop the batch rather than requeue-and-loop, and
          // count it so the closing report says the record is short.
          eventsDropped += batch.length;
          if (err instanceof AerRefusalError) {
            refusedUntilMs = clock() + err.recheckAfterSeconds * 1000;
          }
          fail(err, 'emit');
        }
      }
    })();
    try {
      await draining;
    } finally {
      draining = null;
    }
  }

  function capture(event: CollectorEvent): void {
    if (state === 'closing' || state === 'closed') return; // drop post-close
    if (state === 'idle' && refusedUntilMs !== null) {
      if (clock() < refusedUntilMs) {
        // Still cooling down from an open() refusal: drop rather than queue
        // indefinitely (a usage-cap cooldown can last until period end), and
        // don't retry transport.open() on every event.
        eventsDropped += 1;
        return;
      }
      refusedUntilMs = null; // cooldown elapsed: the attempt below is a fresh episode
    }
    queue.push(event);
    if (state === 'idle') {
      void ensureOpen();
    } else if (state === 'open') {
      void drain().catch((e) => fail(e, 'drain'));
    }
    // 'opening' -> the event is drained at the end of doOpen()
  }

  async function flush(): Promise<void> {
    if (state === 'idle') return;
    if (openPromise) await openPromise;
    await drain();
  }

  async function settleBeforeClose(): Promise<void> {
    if (openPromise) await openPromise;
    await drain();
  }

  async function complete(): Promise<void> {
    if (state === 'closing' || state === 'closed') return;
    if (state === 'idle' && queue.length === 0) { state = 'closed'; return; } // no empty session
    await settleBeforeClose();
    state = 'closing';
    try {
      const closing = deps.closingReport?.({ eventsDropped });
      // A cooldown still in effect means the last attempt already logged the
      // one clear refusal line for this episode; sending the closing report
      // now would just be a second guaranteed-refused request and a second
      // log line for the same cause.
      const cooling = refusedUntilMs !== null && clock() < refusedUntilMs;
      if (closing && !cooling) {
        try { await transport.emit([closing]); } catch (err) { fail(err, 'closing-report'); }
      } else if (closing) {
        eventsDropped += 1;
      }
      await transport.complete();
    } catch (err) {
      fail(err, 'complete');
    }
    state = 'closed';
    tokenCache.clear();
  }

  async function abort(): Promise<void> {
    if (state === 'closing' || state === 'closed') return;
    if (state === 'idle' && queue.length === 0) { state = 'closed'; return; }
    await settleBeforeClose();
    state = 'closing';
    try { await transport.abort(); } catch (err) { fail(err, 'abort'); }
    state = 'closed';
    tokenCache.clear();
  }

  function tokenIsStale(c: CachedToken, now: number): boolean {
    const ttl = Math.max(1, c.expiresAtMs - c.mintedAtMs);
    // Refresh once we're within the last 60s, or the last 20% of the lifetime.
    const threshold = Math.max(60_000, ttl * 0.2);
    return now >= c.expiresAtMs - threshold;
  }

  // Cache key binds the token to audience, the exact scopes requested (so a cached
  // low-scope token never satisfies a higher-scope request), AND
  // whether it is DPoP-bound (a cnf token differs from a bearer one - M3).
  function tokenKey(audience: string, scopes: string[], dpop: boolean): string {
    const base = scopes.length > 0 ? `${audience} ${[...scopes].sort().join(' ')}` : audience;
    return dpop ? `${base} #dpop` : base;
  }

  async function getAttestationFor(audience: string, scopes: string[] = [], dpop = false): Promise<string | null> {
    if (!transport.mintAttestation) return null;
    if (state === 'closing' || state === 'closed') return null;

    const key = tokenKey(audience, scopes, dpop);
    const now = clock();
    const cached = tokenCache.get(key);
    if (cached && !tokenIsStale(cached, now)) return cached.token;

    const existing = tokenInflight.get(key);
    if (existing) return existing;

    // Resolve the DPoP thumbprint to bind BEFORE the async mint so it is stable.
    const dpopJkt = dpop ? ensureDpopKey().jkt : undefined;

    const p = (async (): Promise<string | null> => {
      try {
        await ensureOpen();
        if (state !== 'open' || !transport.mintAttestation) return cached?.token ?? null;
        // Pass the jkt only when binding, so non-DPoP mints keep a 2-arg shape.
        const res = dpopJkt
          ? await transport.mintAttestation(audience, scopes, dpopJkt)
          : await transport.mintAttestation(audience, scopes);
        tokenCache.set(key, { token: res.token, expiresAtMs: res.expiresAtMs, mintedAtMs: clock() });
        return res.token;
      } catch (err) {
        fail(err, 'attestation');
        return cached?.token ?? null; // serve the stale token rather than throw
      } finally {
        tokenInflight.delete(key);
      }
    })();
    tokenInflight.set(key, p);
    return p;
  }

  function peekAttestationFor(audience: string, scopes: string[] = [], dpop = false): string | null {
    if (state === 'closing' || state === 'closed') return null;
    const cached = tokenCache.get(tokenKey(audience, scopes, dpop));
    if (cached && !tokenIsStale(cached, clock())) return cached.token;
    return null;
  }

  function dpopProofFor(method: string, url: string, token: string): string | null {
    if (state === 'closing' || state === 'closed') return null;
    try {
      return ensureDpopKey().proof({ method, url, token, nowSec: Math.floor(clock() / 1000) });
    } catch {
      return null; // never break the host request over a proof failure
    }
  }

  if (deps.eager) void ensureOpen();

  return {
    capture,
    flush,
    complete,
    abort,
    getAttestationFor,
    peekAttestationFor,
    dpopProofFor,
    get state() { return state; },
  };
}
