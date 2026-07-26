import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  verifyAttestation, AttestationError, jwksCache, introspectionCache, createMemoryReplayStore,
  thumbprintFromPeerCert, thumbprintFromForwardedClientCert, type Jwk, type ReplayStore,
} from './index.js';
import { honoAerAttestation } from './hono.js';
import {
  createInMemoryAttestationSigner, signAttestationJwt, signingKeyIdFromPublicKey, type AttestationClaims,
  createInMemorySigner, signDpopProof, jwkThumbprintFromPublicKey, attestationThumbprint,
} from '@aer-oss/attestation-test-utils';

const ISS = 'https://aer-api.adastra.computer';
const AUD = 'mcp://payments-prod';
const NOW_S = 1_780_000_000;
const NOW_MS = NOW_S * 1000;
const JWKS_URL = 'https://aer-api.adastra.computer/.well-known/aer-attestation-jwks.json';

function claims(over: Partial<AttestationClaims> = {}): AttestationClaims {
  return { iss: ISS, aud: AUD, sub: 'agent:a', tenant_id: 't', agent_id: 'a', agent_session_id: 's', environment_id: 'e', iat: NOW_S, nbf: NOW_S, exp: NOW_S + 300, jti: 'j', ...over };
}

async function mint(over: Partial<AttestationClaims> = {}) {
  const signer = createInMemoryAttestationSigner();
  const kid = signingKeyIdFromPublicKey(signer.publicKey());
  const jwk: Jwk = { kty: 'OKP', crv: 'Ed25519', use: 'sig', alg: 'EdDSA', kid, x: Buffer.from(signer.publicKey()).toString('base64url') };
  const token = await signAttestationJwt(signer, kid, claims(over));
  return { token, jwk };
}

function jwksFetch(keys: Jwk[]) {
  return vi.fn(async () => new Response(JSON.stringify({ keys }), { status: 200, headers: { 'cache-control': 'public, max-age=300' } })) as unknown as typeof fetch;
}

const opts = (jwk: Jwk, fetchImpl: typeof fetch, over = {}) => ({
  audience: AUD, issuer: ISS, jwksUrl: JWKS_URL, fetchImpl, now: () => NOW_MS, ...over,
});

beforeEach(() => { jwksCache.reset(); introspectionCache.reset(); });

const INTROSPECT_URL = 'https://aer-api.adastra.computer/v1/attestations/introspect';
function introspectFetch(resp: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(resp), { status })) as unknown as typeof fetch;
}

describe('verifyAttestation', () => {
  it('returns claims for a valid token', async () => {
    const { token, jwk } = await mint();
    const c = await verifyAttestation(token, opts(jwk, jwksFetch([jwk])));
    expect(c).toMatchObject({ aud: AUD, agent_session_id: 's' });
  });

  it('throws expired (outside tolerance)', async () => {
    const { token, jwk } = await mint({ exp: NOW_S - 60 });
    await expect(verifyAttestation(token, opts(jwk, jwksFetch([jwk])))).rejects.toMatchObject({ code: 'expired' });
  });

  it('throws bad_audience and bad_issuer', async () => {
    const { token, jwk } = await mint();
    await expect(verifyAttestation(token, opts(jwk, jwksFetch([jwk]), { audience: 'mcp://other' }))).rejects.toMatchObject({ code: 'bad_audience' });
    await expect(verifyAttestation(token, opts(jwk, jwksFetch([jwk]), { issuer: 'https://evil' }))).rejects.toMatchObject({ code: 'bad_issuer' });
  });

  it('enforces requiredScopes offline (no introspection)', async () => {
    const { token, jwk } = await mint({ scp: ['tools.read', 'mcp:call'] });
    const c = await verifyAttestation(token, opts(jwk, jwksFetch([jwk]), { requiredScopes: ['tools.read'] }));
    expect(c.scp).toEqual(['tools.read', 'mcp:call']);
  });

  it('throws insufficient_scope when a required scope is missing', async () => {
    const { token, jwk } = await mint({ scp: ['tools.read'] });
    await expect(verifyAttestation(token, opts(jwk, jwksFetch([jwk]), { requiredScopes: ['tools.write'] })))
      .rejects.toMatchObject({ code: 'insufficient_scope' });
  });

  it('throws insufficient_scope for a scopeless token when scopes are required', async () => {
    const { token, jwk } = await mint();
    await expect(verifyAttestation(token, opts(jwk, jwksFetch([jwk]), { requiredScopes: ['tools.read'] })))
      .rejects.toMatchObject({ code: 'insufficient_scope' });
  });

  it('throws bad_signature on tamper', async () => {
    const { token, jwk } = await mint();
    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${'A'.repeat(parts[2]!.length)}`;
    await expect(verifyAttestation(tampered, opts(jwk, jwksFetch([jwk])))).rejects.toMatchObject({ code: 'bad_signature' });
  });

  it('caches JWKS — a second verify does not refetch', async () => {
    const { token, jwk } = await mint();
    const f = jwksFetch([jwk]);
    await verifyAttestation(token, opts(jwk, f));
    await verifyAttestation(token, opts(jwk, f));
    expect(f).toHaveBeenCalledOnce();
  });

  it('throws unknown_kid when the key is not published', async () => {
    const { token } = await mint();
    const other: Jwk = { kty: 'OKP', crv: 'Ed25519', kid: 'nope', x: 'AAAA' };
    await expect(verifyAttestation(token, opts(other, jwksFetch([other])))).rejects.toMatchObject({ code: 'unknown_kid' });
  });

  it('rejects a JWKS key whose kty is not OKP (defense in depth)', async () => {
    const { token, jwk } = await mint();
    const wrongType: Jwk = { ...jwk, kty: 'RSA' };
    await expect(verifyAttestation(token, opts(wrongType, jwksFetch([wrongType])))).rejects.toMatchObject({ code: 'bad_key' });
  });

  it('rejects a JWKS key whose crv is not Ed25519', async () => {
    const { token, jwk } = await mint();
    const wrongCrv: Jwk = { ...jwk, crv: 'P-256' };
    await expect(verifyAttestation(token, opts(wrongCrv, jwksFetch([wrongCrv])))).rejects.toMatchObject({ code: 'bad_key' });
  });
});

describe('honoAerAttestation', () => {
  it('403s a request with no token (fail-closed)', async () => {
    const { jwk } = await mint();
    const mw = honoAerAttestation(opts(jwk, jwksFetch([jwk])));
    let nexted = false;
    const c = {
      req: { header: () => undefined },
      set: () => {},
      json: (body: unknown, status: number) => ({ body, status }),
    };
    const res = await mw(c as never, (async () => { nexted = true; }) as never);
    expect(nexted).toBe(false);
    expect((res as { status: number }).status).toBe(403);
  });

  it('calls next + stores claims for a valid token', async () => {
    const { token, jwk } = await mint();
    const mw = honoAerAttestation(opts(jwk, jwksFetch([jwk])));
    let stored: unknown;
    let nexted = false;
    const c = {
      req: { header: (n: string) => (n.toLowerCase() === 'x-aer-attestation' ? token : undefined) },
      set: (_k: string, v: unknown) => { stored = v; },
      json: () => ({}),
    };
    await mw(c as never, (async () => { nexted = true; }) as never);
    expect(nexted).toBe(true);
    expect(stored).toMatchObject({ agent_session_id: 's' });
  });
});

describe('verifyAttestation with introspection', () => {
  const withIntrospect = (jwk: Jwk, introspectImpl: typeof fetch, over: Record<string, unknown> = {}) =>
    opts(jwk, jwksFetch([jwk]), {
      introspect: { url: INTROSPECT_URL, verifierKey: 'aerv_test', fetchImpl: introspectImpl, ...over },
    });

  it('returns claims when introspection reports active', async () => {
    const { token, jwk } = await mint();
    const impl = introspectFetch({ active: true });
    const c = await verifyAttestation(token, withIntrospect(jwk, impl));
    expect(c).toMatchObject({ agent_session_id: 's' });
    expect(impl).toHaveBeenCalledOnce();
  });

  it('sends the token with the verifier key as Bearer', async () => {
    const { token, jwk } = await mint();
    const impl = introspectFetch({ active: true });
    await verifyAttestation(token, withIntrospect(jwk, impl));
    const [url, init] = (impl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe(INTROSPECT_URL);
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer aerv_test' });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ token });
  });

  it('throws revoked (with reason) when introspection reports inactive', async () => {
    const { token, jwk } = await mint();
    const impl = introspectFetch({ active: false, reason: 'jti_revoked' });
    await expect(verifyAttestation(token, withIntrospect(jwk, impl)))
      .rejects.toMatchObject({ code: 'revoked', message: 'jti_revoked' });
  });

  it('caches a positive verdict (one introspect call across two verifies)', async () => {
    const { token, jwk } = await mint();
    const impl = introspectFetch({ active: true });
    await verifyAttestation(token, withIntrospect(jwk, impl));
    await verifyAttestation(token, withIntrospect(jwk, impl));
    expect(impl).toHaveBeenCalledOnce();
  });

  it('fails closed by default when introspection is unreachable', async () => {
    const { token, jwk } = await mint();
    const down = vi.fn(async () => { throw new Error('down'); }) as unknown as typeof fetch;
    await expect(verifyAttestation(token, withIntrospect(jwk, down)))
      .rejects.toMatchObject({ code: 'introspection_unavailable' });
  });

  it('fails closed on a 5xx introspection response', async () => {
    const { token, jwk } = await mint();
    await expect(verifyAttestation(token, withIntrospect(jwk, introspectFetch({}, 503))))
      .rejects.toBeInstanceOf(AttestationError);
  });

  it('fails OPEN when configured, returning the offline-verified claims', async () => {
    const { token, jwk } = await mint();
    const down = vi.fn(async () => { throw new Error('down'); }) as unknown as typeof fetch;
    const c = await verifyAttestation(token, withIntrospect(jwk, down, { onUnavailable: 'fail-open' }));
    expect(c).toMatchObject({ agent_session_id: 's' });
  });
});

describe('verifyAttestation DPoP (M3)', () => {
  const HTU = 'https://mcp.example/mcp';
  const freshStore = (): ReplayStore => {
    const seen = new Map<string, number>();
    return { checkAndRecord: (jti, exp) => { if (seen.has(jti)) return true; seen.set(jti, exp); return false; } };
  };

  // Mint a cnf-bound token plus a matching proof from the same DPoP key.
  async function bound(over: { proofOver?: Record<string, unknown>; dpopSigner?: ReturnType<typeof createInMemorySigner> } = {}) {
    const dpopSigner = over.dpopSigner ?? createInMemorySigner();
    const jkt = jwkThumbprintFromPublicKey(dpopSigner.publicKey());
    const { token, jwk } = await mint({ cnf: { jkt } });
    const proof = await signDpopProof(dpopSigner, {
      htm: 'POST', htu: HTU, iat: NOW_S, jti: `p-${Math.random().toString(36).slice(2)}`, ath: attestationThumbprint(token),
      ...over.proofOver,
    });
    return { token, jwk, proof, dpopSigner };
  }
  const dopts = (jwk: Jwk, over = {}) =>
    opts(jwk, jwksFetch([jwk]), { requireDpop: true, method: 'POST', url: HTU, replayStore: freshStore(), ...over });

  it('accepts a valid proof bound to the token', async () => {
    const { token, jwk, proof } = await bound();
    const c = await verifyAttestation(token, dopts(jwk, { dpopProof: proof }));
    expect(c).toMatchObject({ agent_session_id: 's', cnf: expect.any(Object) });
  });

  it('rejects a token with no cnf when DPoP is required (token_not_bound)', async () => {
    const { token, jwk } = await mint();
    await expect(verifyAttestation(token, dopts(jwk, { dpopProof: 'x.y.z' }))).rejects.toMatchObject({ code: 'dpop_required' });
  });

  it('rejects a missing proof when DPoP is required', async () => {
    const { token, jwk } = await bound();
    await expect(verifyAttestation(token, dopts(jwk, { dpopProof: null }))).rejects.toMatchObject({ code: 'dpop_required' });
  });

  it('rejects a proof signed by a DIFFERENT key (jkt mismatch)', async () => {
    const { token, jwk } = await bound(); // token bound to key A
    const wrong = await signDpopProof(createInMemorySigner(), { htm: 'POST', htu: HTU, iat: NOW_S, jti: 'w', ath: attestationThumbprint(token) });
    await expect(verifyAttestation(token, dopts(jwk, { dpopProof: wrong }))).rejects.toMatchObject({ code: 'dpop_invalid' });
  });

  it('rejects a wrong method and a wrong URL', async () => {
    const { token, jwk, proof } = await bound();
    await expect(verifyAttestation(token, dopts(jwk, { dpopProof: proof, method: 'GET' }))).rejects.toMatchObject({ code: 'dpop_invalid' });
    await expect(verifyAttestation(token, dopts(jwk, { dpopProof: proof, url: 'https://mcp.example/other' }))).rejects.toMatchObject({ code: 'dpop_invalid' });
  });

  it('rejects a proof whose ath hashes a different token (same key binding)', async () => {
    const dpopSigner = createInMemorySigner();
    const jkt = jwkThumbprintFromPublicKey(dpopSigner.publicKey());
    const { token } = await mint({ cnf: { jkt } });
    const { token: otherToken, jwk } = await mint({ cnf: { jkt } }); // bound to the SAME key
    // proof's ath hashes `token`, but we present `otherToken` -> ath_mismatch.
    const proof = await signDpopProof(dpopSigner, { htm: 'POST', htu: HTU, iat: NOW_S, jti: 'ath-x', ath: attestationThumbprint(token) });
    await expect(verifyAttestation(otherToken, dopts(jwk, { dpopProof: proof }))).rejects.toMatchObject({ code: 'dpop_invalid' });
  });

  it('rejects a stale proof (iat outside the freshness window)', async () => {
    const { token, jwk, proof } = await bound({ proofOver: { iat: NOW_S - 600 } });
    await expect(verifyAttestation(token, dopts(jwk, { dpopProof: proof, dpopMaxAgeSec: 120 }))).rejects.toMatchObject({ code: 'dpop_invalid' });
  });

  it('blocks a replayed proof (same jti twice)', async () => {
    const { token, jwk, proof } = await bound();
    const store = freshStore();
    const first = await verifyAttestation(token, dopts(jwk, { dpopProof: proof, replayStore: store }));
    expect(first).toMatchObject({ agent_session_id: 's' });
    await expect(verifyAttestation(token, dopts(jwk, { dpopProof: proof, replayStore: store }))).rejects.toMatchObject({ code: 'dpop_replay' });
  });

  it('ignores DPoP when requireDpop is off (bearer behavior preserved)', async () => {
    const { token, jwk } = await bound(); // cnf-bound token, but resource does not require DPoP
    const c = await verifyAttestation(token, opts(jwk, jwksFetch([jwk]))); // no requireDpop
    expect(c).toMatchObject({ agent_session_id: 's' });
  });

  it('uses a tight 5s DPoP skew by default (not the 30s JWT tolerance)', async () => {
    // 20s in the future: within JWT skew (30) but outside the DPoP default (5).
    const { token, jwk, proof } = await bound({ proofOver: { iat: NOW_S + 20 } });
    await expect(verifyAttestation(token, dopts(jwk, { dpopProof: proof }))).rejects.toMatchObject({ code: 'dpop_invalid' });
    // an explicit wider DPoP tolerance accepts it
    const ok = await verifyAttestation(token, dopts(jwk, { dpopProof: proof, dpopClockToleranceSec: 60 }));
    expect(ok).toMatchObject({ agent_session_id: 's' });
  });
});

describe('createMemoryReplayStore (M3)', () => {
  const FAR = 9_999_999_999_999;
  it('detects a replay of the same key', () => {
    const store = createMemoryReplayStore(10);
    expect(store.checkAndRecord('k', FAR)).toBe(false);
    expect(store.checkAndRecord('k', FAR)).toBe(true);
  });

  it('fails CLOSED when full of unexpired entries (bounded memory)', () => {
    const store = createMemoryReplayStore(1);
    expect(store.checkAndRecord('a', FAR)).toBe(false); // fills the single slot
    expect(store.checkAndRecord('b', FAR)).toBe(true);  // full + unexpired → denied
  });

  it('reclaims expired entries to admit fresh keys', () => {
    const store = createMemoryReplayStore(1);
    expect(store.checkAndRecord('a', 1)).toBe(false); // expires immediately (past ms)
    expect(store.checkAndRecord('b', FAR)).toBe(false); // GC drops 'a', slot freed
  });
});

describe('verifyAttestation mTLS (RFC 8705)', () => {
  const X5T = 'cert-thumb-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // opaque to verify (string compare)
  const mopts = (jwk: Jwk, over = {}) => opts(jwk, jwksFetch([jwk]), { requireMtls: true, ...over });

  it('accepts a cert-bound token when the presented thumbprint matches', async () => {
    const { token, jwk } = await mint({ cnf: { 'x5t#S256': X5T } });
    const c = await verifyAttestation(token, mopts(jwk, { mtlsThumbprint: X5T }));
    expect(c).toMatchObject({ agent_session_id: 's' });
  });

  it('rejects a token with no cnf x5t when mTLS is required (mtls_required)', async () => {
    const { token, jwk } = await mint();
    await expect(verifyAttestation(token, mopts(jwk, { mtlsThumbprint: X5T }))).rejects.toMatchObject({ code: 'mtls_required' });
  });

  it('rejects when no client cert thumbprint is presented (mtls_required)', async () => {
    const { token, jwk } = await mint({ cnf: { 'x5t#S256': X5T } });
    await expect(verifyAttestation(token, mopts(jwk, { mtlsThumbprint: null }))).rejects.toMatchObject({ code: 'mtls_required' });
  });

  it('rejects a thumbprint mismatch (mtls_invalid)', async () => {
    const { token, jwk } = await mint({ cnf: { 'x5t#S256': X5T } });
    await expect(verifyAttestation(token, mopts(jwk, { mtlsThumbprint: 'someone-elses-cert' }))).rejects.toMatchObject({ code: 'mtls_invalid' });
  });

  it('ignores mTLS when requireMtls is off (bearer behavior preserved)', async () => {
    const { token, jwk } = await mint({ cnf: { 'x5t#S256': X5T } });
    const c = await verifyAttestation(token, opts(jwk, jwksFetch([jwk]))); // no requireMtls
    expect(c).toMatchObject({ agent_session_id: 's' });
  });

  it('can require BOTH DPoP and mTLS (both must pass)', async () => {
    const dpopSigner = createInMemorySigner();
    const jkt = jwkThumbprintFromPublicKey(dpopSigner.publicKey());
    const { token, jwk } = await mint({ cnf: { jkt, 'x5t#S256': X5T } });
    const proof = await signDpopProof(dpopSigner, { htm: 'POST', htu: 'https://mcp/x', iat: NOW_S, jti: 'both-1', ath: attestationThumbprint(token) });
    const base = { requireDpop: true, method: 'POST', url: 'https://mcp/x', requireMtls: true };

    // both satisfied → ok
    const ok = await verifyAttestation(token, opts(jwk, jwksFetch([jwk]), { ...base, dpopProof: proof, mtlsThumbprint: X5T, replayStore: createMemoryReplayStore() }));
    expect(ok).toMatchObject({ agent_session_id: 's' });

    // DPoP ok but mTLS thumbprint wrong → mtls_invalid
    const proof2 = await signDpopProof(dpopSigner, { htm: 'POST', htu: 'https://mcp/x', iat: NOW_S, jti: 'both-2', ath: attestationThumbprint(token) });
    await expect(verifyAttestation(token, opts(jwk, jwksFetch([jwk]), { ...base, dpopProof: proof2, mtlsThumbprint: 'wrong', replayStore: createMemoryReplayStore() })))
      .rejects.toMatchObject({ code: 'mtls_invalid' });
  });
});

describe('mTLS thumbprint helpers', () => {
  const DER = new Uint8Array([0x30, 0x82, 0x01, 0x02, 0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03]);
  const expected = createHash('sha256').update(DER).digest('base64url');
  const pem = `-----BEGIN CERTIFICATE-----\n${Buffer.from(DER).toString('base64')}\n-----END CERTIFICATE-----`;

  it('thumbprintFromPeerCert hashes the socket peer cert DER', async () => {
    const socket = { getPeerCertificate: () => ({ raw: Buffer.from(DER) }) };
    expect(await thumbprintFromPeerCert(socket)).toBe(expected);
  });

  it('thumbprintFromPeerCert returns null with no client cert', async () => {
    expect(await thumbprintFromPeerCert({ getPeerCertificate: () => ({}) })).toBeNull();
    expect(await thumbprintFromPeerCert(null)).toBeNull();
  });

  it('thumbprintFromForwardedClientCert parses a (url-encoded) PEM header', async () => {
    expect(await thumbprintFromForwardedClientCert(pem)).toBe(expected);
    expect(await thumbprintFromForwardedClientCert(encodeURIComponent(pem))).toBe(expected);
  });

  it('thumbprintFromForwardedClientCert reads an Envoy XFCC Hash= (hex) directly', async () => {
    const hex = createHash('sha256').update(DER).digest('hex');
    const xfcc = `By=spiffe://x;Hash=${hex};Subject="CN=agent"`;
    expect(await thumbprintFromForwardedClientCert(xfcc, { format: 'xfcc' })).toBe(expected);
  });

  it('thumbprintFromForwardedClientCert falls back to XFCC Cert="<pem>"', async () => {
    const xfcc = `By=spiffe://x;Cert="${encodeURIComponent(pem)}"`;
    expect(await thumbprintFromForwardedClientCert(xfcc, { format: 'xfcc' })).toBe(expected);
  });

  it('returns null for empty/garbage input', async () => {
    expect(await thumbprintFromForwardedClientCert(null)).toBeNull();
    expect(await thumbprintFromForwardedClientCert('')).toBeNull();
  });

  it('ignores a malformed XFCC Hash that is not exactly 64 hex chars', async () => {
    expect(await thumbprintFromForwardedClientCert('Hash=deadbeef', { format: 'xfcc' })).toBeNull(); // too short
    const tooLong = 'a'.repeat(65);
    expect(await thumbprintFromForwardedClientCert(`Hash=${tooLong}`, { format: 'xfcc' })).toBeNull();
  });
});
