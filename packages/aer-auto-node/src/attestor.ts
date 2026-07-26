// Attestation injector for the transport patches (2b).
//
// Maps a request host -> configured audience, then supplies an `X-AER-Attestation`
// token: awaited for the fetch path, cache-only (with background warm) for the
// synchronous node:http path. All methods are best-effort and never throw.
//
// Token minting + caching lives in the session manager; this is the thin,
// patch-facing surface that the fetch/http patches share, plus coverage counters.

import { audienceForHost, resourceForHost, type ProtectedResource } from './config.js';
import { decideEgress, decodeTokenScopes, type EgressDecision } from './egress.js';

export interface AttestorStats {
  /** Requests that carried an injected token. */
  injected: number;
  /** Protected requests with no cached/awaited token available at call time. */
  cache_miss: number;
  /** Background cache-warm attempts that failed to produce a token. */
  warm_failed: number;
  /** Redirect hops where the token was stripped because the next hop left the audience. */
  redirect_cross_origin_stripped: number;
  /** Injected fetches that fell back to no-follow (one-shot/streamed body). */
  redirect_manual_fallback: number;
  /** Egress requests denied (block mode). */
  egress_blocked: number;
  /** Egress requests that block WOULD have denied but report mode let through. */
  egress_would_block: number;
  /** Block-mode requests allowed because minting was unavailable + fail_open. */
  egress_unavailable_fail_open: number;
  /** Decisions whose reason was a missing required scope (block or report). */
  egress_insufficient_scope: number;
}

export interface Attestor {
  /** Audience for `host` if it's a configured protected resource, else null. */
  audienceFor(host: string): string | null;
  /** The matched protected resource for `host` (carries enforcement), else null. */
  resourceFor(host: string): ProtectedResource | null;
  /**
   * Decide whether an outbound request to `resource` may proceed given the token
   * obtained for it (null if minting was unavailable). Pure decision + counter
   * bookkeeping; the patch turns a deny into a synthetic 403 / connection error.
   */
  evaluateEgress(resource: ProtectedResource, token: string | null): EgressDecision;
  /**
   * Await a token for `audience` requesting `scopes` (fetch path). Scopes come
   * from the matched resource (NOT looked up by audience) so two resources that
   * share an audience but require different scopes never cross caches. Never throws.
   */
  getToken(audience: string, scopes: string[], dpop?: boolean): Promise<string | null>;
  /**
   * Read a cached token synchronously (node:http path) for `audience` + `scopes`.
   * On a cold miss, kicks off a background warm so a later request to the same
   * audience+scopes is covered. Never throws.
   */
  peekToken(audience: string, scopes: string[], dpop?: boolean): string | null;
  /**
   * Sign a DPoP proof for a request to a DPoP-enabled resource (M3), or null when
   * unsupported/closed. The patch attaches it as the `DPoP` header. Never throws.
   */
  dpopProof(method: string, url: string, token: string): string | null;
  /** Record that a token was actually placed on a request. */
  recordInjected(): void;
  /** Record a redirect hop where the token was stripped (left the audience). */
  recordCrossOriginStripped(): void;
  /** Record an injected fetch that could not safely follow redirects. */
  recordManualFallback(): void;
  readonly stats: AttestorStats;
}

export interface AttestorDeps {
  resources: ProtectedResource[];
  /** Async mint+cache for `audience` (the session manager's getAttestationFor). */
  getAttestationFor(audience: string, scopes?: string[], dpop?: boolean): Promise<string | null>;
  /** Sync, side-effect-free cached-token read (the session manager's peek). */
  peekAttestationFor(audience: string, scopes?: string[], dpop?: boolean): string | null;
  /** Sign a DPoP proof for a request (the session manager's dpopProofFor). Optional. */
  dpopProofFor?(method: string, url: string, token: string): string | null;
}

export function createAttestor(deps: AttestorDeps): Attestor {
  const stats: AttestorStats = {
    injected: 0, cache_miss: 0, warm_failed: 0,
    redirect_cross_origin_stripped: 0, redirect_manual_fallback: 0,
    egress_blocked: 0, egress_would_block: 0,
    egress_unavailable_fail_open: 0, egress_insufficient_scope: 0,
  };

  function audienceFor(host: string): string | null {
    if (deps.resources.length === 0) return null;
    return audienceForHost(host, deps.resources);
  }

  function resourceFor(host: string): ProtectedResource | null {
    if (deps.resources.length === 0) return null;
    return resourceForHost(host, deps.resources);
  }

  function evaluateEgress(resource: ProtectedResource, token: string | null): EgressDecision {
    // Decode scopes only when enforcement is on (off short-circuits anyway).
    const scopes = resource.enforcement === 'off' ? [] : decodeTokenScopes(token);
    const decision = decideEgress(resource, { token, scopes });
    if (!decision.allow) stats.egress_blocked += 1;
    else if (decision.event === 'would_block') stats.egress_would_block += 1;
    else if (decision.event === 'unavailable_fail_open') stats.egress_unavailable_fail_open += 1;
    if (decision.reason === 'insufficient_scope') stats.egress_insufficient_scope += 1;
    return decision;
  }

  async function getToken(audience: string, scopes: string[], dpop = false): Promise<string | null> {
    try {
      const token = await deps.getAttestationFor(audience, scopes, dpop);
      if (!token) stats.cache_miss += 1;
      return token;
    } catch {
      stats.cache_miss += 1;
      return null; // the patch proceeds without a header; fail-closed at the resource
    }
  }

  function warm(audience: string, scopes: string[], dpop: boolean): void {
    // Fire-and-forget: produce a token for the NEXT request to this audience+scopes.
    void Promise.resolve()
      .then(() => deps.getAttestationFor(audience, scopes, dpop))
      .then((t) => { if (!t) stats.warm_failed += 1; })
      .catch(() => { stats.warm_failed += 1; });
  }

  function peekToken(audience: string, scopes: string[], dpop = false): string | null {
    let token: string | null = null;
    try {
      token = deps.peekAttestationFor(audience, scopes, dpop);
    } catch {
      token = null;
    }
    if (token) return token;
    stats.cache_miss += 1;
    warm(audience, scopes, dpop);
    return null;
  }

  function dpopProof(method: string, url: string, token: string): string | null {
    try {
      return deps.dpopProofFor ? deps.dpopProofFor(method, url, token) : null;
    } catch {
      return null;
    }
  }

  return {
    audienceFor,
    resourceFor,
    evaluateEgress,
    getToken,
    peekToken,
    dpopProof,
    recordInjected: () => { stats.injected += 1; },
    recordCrossOriginStripped: () => { stats.redirect_cross_origin_stripped += 1; },
    recordManualFallback: () => { stats.redirect_manual_fallback += 1; },
    stats,
  };
}
