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

export interface SessionManagerDeps {
  transport: SessionTransport;
  /** Events emitted immediately after open, before any captured event. */
  preamble?: () => CollectorEvent[];
  /** Optional final coverage event emitted just before complete(). */
  closingReport?: () => CollectorEvent | null;
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
  let draining = false;

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
      state = 'closed';
      queue.length = 0;
      return;
    }
    try {
      const pre = preamble();
      if (pre.length > 0) await transport.emit(pre);
    } catch (err) {
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

  async function drain(): Promise<void> {
    // Re-entrancy guard (defense-in-depth): if emit() itself triggers a capture
    // (e.g. a mis-wired patched transport), don't recurse into a nested emit.
    if (state !== 'open' || draining || queue.length === 0) return;
    draining = true;
    const batch = queue.splice(0, queue.length);
    try {
      await transport.emit(batch);
    } catch (err) {
      // Bounded + never-throw: drop the batch rather than requeue-and-loop.
      fail(err, 'emit');
    } finally {
      draining = false;
    }
  }

  function capture(event: CollectorEvent): void {
    if (state === 'closing' || state === 'closed') return; // drop post-close
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
      const closing = deps.closingReport?.();
      if (closing) {
        try { await transport.emit([closing]); } catch (err) { fail(err, 'closing-report'); }
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
