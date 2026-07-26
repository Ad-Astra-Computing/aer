import { describe, it, expect, beforeEach, vi } from 'vitest';
import { guardMcpRequest, statusForReason, MCP_ATTESTATION_ERROR_CODE, type GuardOptions } from './index.js';
import { jwksCache, introspectionCache } from '@adastracomputing/aer-resource-node';
import {
  createInMemoryAttestationSigner, signAttestationJwt, signingKeyIdFromPublicKey, type AttestationClaims, type Jwk,
  createInMemorySigner, signDpopProof, jwkThumbprintFromPublicKey, attestationThumbprint,
} from '@aer-oss/attestation-test-utils';

const ISS = 'https://aer-api.adastra.computer';
const AUD = 'mcp://payments-prod';
const NOW_S = 1_780_000_000;
const NOW_MS = NOW_S * 1000;
const JWKS_URL = 'https://aer-api.adastra.computer/.well-known/aer-attestation-jwks.json';
const INTROSPECT_URL = 'https://aer-api.adastra.computer/v1/attestations/introspect';

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

const jwksFetch = (keys: Jwk[]) =>
  vi.fn(async () => new Response(JSON.stringify({ keys }), { status: 200, headers: { 'cache-control': 'max-age=300' } })) as unknown as typeof fetch;
const introspectFetch = (resp: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(resp), { status })) as unknown as typeof fetch;

const opts = (jwk: Jwk, fetchImpl: typeof fetch, over: Partial<GuardOptions> = {}): GuardOptions => ({
  audience: AUD, issuer: ISS, jwksUrl: JWKS_URL, fetchImpl, now: () => NOW_MS, ...over,
});
const header = (token?: string) => (n: string) => (n.toLowerCase() === 'x-aer-attestation' ? token : undefined);

beforeEach(() => { jwksCache.reset(); introspectionCache.reset(); });

describe('guardMcpRequest', () => {
  it('passes a valid token and returns claims', async () => {
    const { token, jwk } = await mint();
    const r = await guardMcpRequest(header(token), opts(jwk, jwksFetch([jwk])));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claims).toMatchObject({ agent_session_id: 's', aud: AUD });
  });

  it('passes when the token carries the required scope', async () => {
    const { token, jwk } = await mint({ scp: ['tools.read'] });
    const r = await guardMcpRequest(header(token), opts(jwk, jwksFetch([jwk]), { requiredScopes: ['tools.read'] }));
    expect(r.ok).toBe(true);
  });

  it('denies a token missing a required scope with 403 insufficient_scope', async () => {
    const { token, jwk } = await mint({ scp: ['tools.read'] });
    const r = await guardMcpRequest(header(token), opts(jwk, jwksFetch([jwk]), { requiredScopes: ['tools.write'] }), 9);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.jsonRpcError.error.data.reason).toBe('insufficient_scope');
    }
  });

  it('denies a missing token with 401 + JSON-RPC error (echoing the id)', async () => {
    const { jwk } = await mint();
    const r = await guardMcpRequest(header(undefined), opts(jwk, jwksFetch([jwk])), 7);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(401);
      expect(r.jsonRpcError).toEqual({
        jsonrpc: '2.0', id: 7,
        error: { code: MCP_ATTESTATION_ERROR_CODE, message: 'attestation required', data: { reason: 'missing_attestation' } },
      });
    }
  });

  it('denies an expired token with 401 expired', async () => {
    const { token, jwk } = await mint({ exp: NOW_S - 60 });
    const r = await guardMcpRequest(header(token), opts(jwk, jwksFetch([jwk])));
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(401); expect(r.jsonRpcError.error.data.reason).toBe('expired'); }
  });

  it('denies a wrong-audience token with 401 bad_audience', async () => {
    const { token, jwk } = await mint();
    const r = await guardMcpRequest(header(token), opts(jwk, jwksFetch([jwk]), { audience: 'mcp://other' }));
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(401); expect(r.jsonRpcError.error.data.reason).toBe('bad_audience'); }
  });

  it('denies a revoked token (introspection inactive) with 403 revoked', async () => {
    const { token, jwk } = await mint();
    const r = await guardMcpRequest(header(token), opts(jwk, jwksFetch([jwk]), {
      introspect: { url: INTROSPECT_URL, verifierKey: 'aerv_x', fetchImpl: introspectFetch({ active: false, reason: 'jti_revoked' }) },
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(403); expect(r.jsonRpcError.error.data.reason).toBe('revoked'); }
  });

  it('denies with 503 when introspection is unreachable (fail-closed)', async () => {
    const { token, jwk } = await mint();
    const down = vi.fn(async () => { throw new Error('down'); }) as unknown as typeof fetch;
    const r = await guardMcpRequest(header(token), opts(jwk, jwksFetch([jwk]), {
      introspect: { url: INTROSPECT_URL, verifierKey: 'aerv_x', fetchImpl: down },
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(503); expect(r.jsonRpcError.error.data.reason).toBe('introspection_unavailable'); }
  });

  it('reads Authorization: Bearer only when allowBearer is set', async () => {
    const { token, jwk } = await mint();
    const bearer = (n: string) => (n.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined);
    expect((await guardMcpRequest(bearer, opts(jwk, jwksFetch([jwk])))).ok).toBe(false); // header not read
    expect((await guardMcpRequest(bearer, opts(jwk, jwksFetch([jwk]), { allowBearer: true }))).ok).toBe(true);
  });
});

describe('statusForReason', () => {
  it('maps reasons to HTTP statuses', () => {
    expect(statusForReason('revoked')).toBe(403);
    expect(statusForReason('introspection_unavailable')).toBe(503);
    expect(statusForReason('expired')).toBe(401);
    expect(statusForReason('bad_signature')).toBe(401);
    expect(statusForReason('missing_attestation')).toBe(401);
  });
});

describe('guardMcpRequest DPoP (M3)', () => {
  const MURL = 'https://mcp.example/mcp';
  // header getter that serves both the attestation token and a DPoP proof
  const hdr2 = (token?: string, dpop?: string) => (n: string) => {
    const k = n.toLowerCase();
    if (k === 'x-aer-attestation') return token;
    if (k === 'dpop') return dpop;
    return undefined;
  };
  const freshStore = () => {
    const seen = new Map<string, number>();
    return { checkAndRecord: (jti: string, exp: number) => { if (seen.has(jti)) return true; seen.set(jti, exp); return false; } };
  };
  async function bound(proofOver: Record<string, unknown> = {}) {
    const dpopSigner = createInMemorySigner();
    const jkt = jwkThumbprintFromPublicKey(dpopSigner.publicKey());
    const { token, jwk } = await mint({ cnf: { jkt } });
    const proof = await signDpopProof(dpopSigner, { htm: 'POST', htu: MURL, iat: NOW_S, jti: `p-${Math.random().toString(36).slice(2)}`, ath: attestationThumbprint(token), ...proofOver });
    return { token, jwk, proof };
  }
  const dopts = (jwk: Jwk, over = {}) =>
    opts(jwk, jwksFetch([jwk]), { requireDpop: true, method: 'POST', url: MURL, replayStore: freshStore(), ...over });

  it('admits a request carrying a valid DPoP proof', async () => {
    const { token, jwk, proof } = await bound();
    const r = await guardMcpRequest(hdr2(token, proof), dopts(jwk));
    expect(r.ok).toBe(true);
  });

  it('denies (401) a DPoP-required request with no DPoP header', async () => {
    const { token, jwk } = await bound();
    const r = await guardMcpRequest(hdr2(token, undefined), dopts(jwk), 4);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(401); expect(r.jsonRpcError.error.data.reason).toBe('dpop_required'); }
  });

  it('denies (401) a replayed proof', async () => {
    const { token, jwk, proof } = await bound();
    const store = freshStore();
    const first = await guardMcpRequest(hdr2(token, proof), dopts(jwk, { replayStore: store }));
    expect(first.ok).toBe(true);
    const second = await guardMcpRequest(hdr2(token, proof), dopts(jwk, { replayStore: store }));
    expect(second.ok).toBe(false);
    if (!second.ok) { expect(second.status).toBe(401); expect(second.jsonRpcError.error.data.reason).toBe('dpop_replay'); }
  });

  it('a non-DPoP resource still admits a plain bearer token (opt-in preserved)', async () => {
    const { token, jwk } = await mint();
    const r = await guardMcpRequest(header(token), opts(jwk, jwksFetch([jwk])));
    expect(r.ok).toBe(true);
  });
});

describe('guardMcpRequest mTLS (RFC 8705)', () => {
  const X5T = 'cert-thumbprint-bbbbbbbbbbbbbbbbbbbbbbbbbbb';
  // header getter serving the attestation token + a (test) resolved cert thumbprint
  const hdrM = (token?: string, thumb?: string) => (n: string) => {
    const k = n.toLowerCase();
    if (k === 'x-aer-attestation') return token;
    if (k === 'x-cert-thumb') return thumb;
    return undefined;
  };
  const resolveMtlsThumbprint = (get: (n: string) => string | null | undefined) => get('x-cert-thumb') ?? null;

  it('admits a request whose presented cert thumbprint matches cnf.x5t#S256', async () => {
    const { token, jwk } = await mint({ cnf: { 'x5t#S256': X5T } });
    const r = await guardMcpRequest(hdrM(token, X5T), opts(jwk, jwksFetch([jwk]), { requireMtls: true, resolveMtlsThumbprint }));
    expect(r.ok).toBe(true);
  });

  it('denies (401) a token with no cert binding when mTLS is required', async () => {
    const { token, jwk } = await mint();
    const r = await guardMcpRequest(hdrM(token, X5T), opts(jwk, jwksFetch([jwk]), { requireMtls: true, resolveMtlsThumbprint }), 3);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(401); expect(r.jsonRpcError.error.data.reason).toBe('mtls_required'); }
  });

  it('denies (401) when the presented thumbprint does not match (mtls_invalid)', async () => {
    const { token, jwk } = await mint({ cnf: { 'x5t#S256': X5T } });
    const r = await guardMcpRequest(hdrM(token, 'wrong-cert'), opts(jwk, jwksFetch([jwk]), { requireMtls: true, resolveMtlsThumbprint }));
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(401); expect(r.jsonRpcError.error.data.reason).toBe('mtls_invalid'); }
  });

  it('maps mtls_* reasons to 401', () => {
    expect(statusForReason('mtls_required')).toBe(401);
    expect(statusForReason('mtls_invalid')).toBe(401);
  });
});
