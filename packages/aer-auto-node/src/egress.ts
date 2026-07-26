// Egress enforcement policy (Phase 3 M2) — pure decision logic.
//
// Today the collector is purely additive: it attaches X-AER-Attestation when it
// can mint, and otherwise does nothing. M2 lets an operator opt a protected
// resource into DENYING outbound requests that have no valid attestation. This
// changes runtime network behavior, so it is per-resource and staged:
//   off    — today's behavior (attach when possible, never block). DEFAULT.
//   report — never block, but emit a would_block event for what block WOULD deny.
//   block  — deny the request (synthetic 403 / connection error at the patch).
//
// "No valid attestation" means either (a) we could not mint a token at all
// (session/API unavailable) or (b) the token does not carry the scopes this
// resource requires. (a) is an availability condition governed by onUnavailable;
// (b) is a definitive policy answer (the operator has not granted the scope) and
// always denies in block mode — we must not send the request body to a resource
// the agent is not authorized for, just to let it 403.

import type { ProtectedResource } from './config.js';

export type EgressReason = 'unavailable' | 'insufficient_scope';

export interface EgressDecision {
  /** Whether the outbound request is allowed to proceed. */
  allow: boolean;
  /**
   * Which observability event (if any) this decision warrants:
   *   none                 — nothing to report (allowed, fully valid, or off)
   *   blocked              — request denied
   *   would_block          — report mode: allowed, but block would have denied
   *   unavailable_fail_open — block mode, mint unavailable, allowed by fail-open
   */
  event: 'none' | 'blocked' | 'would_block' | 'unavailable_fail_open';
  reason?: EgressReason;
}

export interface EgressTokenResult {
  /** The minted token, or null if minting was unavailable. */
  token: string | null;
  /** Scopes carried by the token (decoded from its `scp` claim), [] if none. */
  scopes: string[];
}

/**
 * Decode the `scp` (scopes) claim from an attestation JWT without verifying its
 * signature. The collector minted this token from the trusted AER API moments
 * ago, so this is just reading back what we requested+were granted; the resource
 * still verifies the signature. Never throws — returns [] on any malformation.
 */
export function decodeTokenScopes(token: string | null | undefined): string[] {
  if (!token) return [];
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) return [];
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(json) as { scp?: unknown };
    if (!Array.isArray(payload.scp)) return [];
    return payload.scp.filter((s): s is string => typeof s === 'string');
  } catch {
    return [];
  }
}

/** Does `granted` cover every scope in `required`? Empty required ⟹ satisfied. */
function satisfies(required: string[], granted: string[]): boolean {
  if (required.length === 0) return true;
  const have = new Set(granted);
  return required.every((s) => have.has(s));
}

/**
 * Decide whether an outbound request to a protected resource may proceed, given
 * the token (and its scopes) the collector was able to obtain. Pure: the patch
 * layer turns a deny into a synthetic 403 / connection error and emits the event.
 */
export function decideEgress(resource: ProtectedResource, tokenResult: EgressTokenResult): EgressDecision {
  if (resource.enforcement === 'off') return { allow: true, event: 'none' };

  const reason: EgressReason | null = !tokenResult.token
    ? 'unavailable'
    : !satisfies(resource.scopes ?? [], tokenResult.scopes)
      ? 'insufficient_scope'
      : null;

  if (reason === null) return { allow: true, event: 'none' };

  if (resource.enforcement === 'report') {
    return { allow: true, event: 'would_block', reason };
  }

  // block mode. An availability gap may be waived by fail-open; an insufficient
  // scope is a policy denial and is never waived.
  if (reason === 'unavailable' && resource.onUnavailable === 'fail_open') {
    return { allow: true, event: 'unavailable_fail_open', reason };
  }
  return { allow: false, event: 'blocked', reason };
}
