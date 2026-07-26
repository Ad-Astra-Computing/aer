import { describe, it, expect } from 'vitest';
import { decideEgress, decodeTokenScopes } from './egress.js';
import type { ProtectedResource } from './config.js';

function resource(over: Partial<ProtectedResource> = {}): ProtectedResource {
  return {
    host: 'mcp.internal',
    audience: 'mcp://x',
    scopes: [],
    enforcement: 'off',
    onUnavailable: 'fail_closed',
    dpop: false,
    ...over,
  };
}

// Build a JWT-shaped string (header.payload.sig) carrying the given scp claim.
function tokenWithScopes(scp?: string[]): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const payload = scp === undefined ? { aud: 'mcp://x' } : { aud: 'mcp://x', scp };
  return `${b64({ alg: 'EdDSA', typ: 'aer-attestation+jwt' })}.${b64(payload)}.sig`;
}

describe('decodeTokenScopes', () => {
  it('reads the scp claim from a JWT payload', () => {
    expect(decodeTokenScopes(tokenWithScopes(['payments.read', 'payments.write']))).toEqual([
      'payments.read',
      'payments.write',
    ]);
  });

  it('returns [] when there is no scp claim', () => {
    expect(decodeTokenScopes(tokenWithScopes())).toEqual([]);
  });

  it('returns [] for null, empty, or malformed tokens (never throws)', () => {
    expect(decodeTokenScopes(null)).toEqual([]);
    expect(decodeTokenScopes('')).toEqual([]);
    expect(decodeTokenScopes('not-a-jwt')).toEqual([]);
    expect(decodeTokenScopes('a.b')).toEqual([]);
    expect(decodeTokenScopes('a.%%%.c')).toEqual([]);
  });

  it('ignores a non-array or non-string-element scp claim', () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    expect(decodeTokenScopes(`x.${b64({ scp: 'read' })}.s`)).toEqual([]);
    expect(decodeTokenScopes(`x.${b64({ scp: ['read', 7] })}.s`)).toEqual(['read']);
  });
});

describe('decideEgress', () => {
  const present = (scp?: string[]) => ({ token: tokenWithScopes(scp), scopes: decodeTokenScopes(tokenWithScopes(scp)) });
  const absent = { token: null, scopes: [] as string[] };

  it('off: always allows, emits nothing (additive behavior preserved)', () => {
    expect(decideEgress(resource({ enforcement: 'off' }), absent)).toEqual({ allow: true, event: 'none' });
    expect(decideEgress(resource({ enforcement: 'off', scopes: ['x'] }), present())).toEqual({ allow: true, event: 'none' });
  });

  it('block + no token (unavailable) + fail_closed: blocks', () => {
    const d = decideEgress(resource({ enforcement: 'block', onUnavailable: 'fail_closed' }), absent);
    expect(d).toEqual({ allow: false, event: 'blocked', reason: 'unavailable' });
  });

  it('block + no token (unavailable) + fail_open: allows, flags fail-open', () => {
    const d = decideEgress(resource({ enforcement: 'block', onUnavailable: 'fail_open' }), absent);
    expect(d).toEqual({ allow: true, event: 'unavailable_fail_open', reason: 'unavailable' });
  });

  it('block + valid token covering required scopes: allows silently', () => {
    const d = decideEgress(resource({ enforcement: 'block', scopes: ['payments.read'] }), present(['payments.read']));
    expect(d).toEqual({ allow: true, event: 'none' });
  });

  it('block + token missing a required scope: blocks (insufficient_scope), ignores onUnavailable', () => {
    const d = decideEgress(
      resource({ enforcement: 'block', scopes: ['payments.write'], onUnavailable: 'fail_open' }),
      present(['payments.read']),
    );
    expect(d).toEqual({ allow: false, event: 'blocked', reason: 'insufficient_scope' });
  });

  it('block + audience-only resource (no required scopes) + token present: allows', () => {
    const d = decideEgress(resource({ enforcement: 'block', scopes: [] }), present());
    expect(d).toEqual({ allow: true, event: 'none' });
  });

  it('report + no token: allows but flags would_block (unavailable)', () => {
    const d = decideEgress(resource({ enforcement: 'report' }), absent);
    expect(d).toEqual({ allow: true, event: 'would_block', reason: 'unavailable' });
  });

  it('report + insufficient scope: allows but flags would_block (insufficient_scope)', () => {
    const d = decideEgress(resource({ enforcement: 'report', scopes: ['payments.write'] }), present(['payments.read']));
    expect(d).toEqual({ allow: true, event: 'would_block', reason: 'insufficient_scope' });
  });

  it('report + valid: allows silently', () => {
    const d = decideEgress(resource({ enforcement: 'report', scopes: ['payments.read'] }), present(['payments.read']));
    expect(d).toEqual({ allow: true, event: 'none' });
  });
});
