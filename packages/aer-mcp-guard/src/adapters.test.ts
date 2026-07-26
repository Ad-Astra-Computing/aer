import { describe, it, expect, beforeEach, vi } from 'vitest';
import { honoMcpGuard } from './hono.js';
import { expressMcpGuard } from './express.js';
import type { GuardOptions } from './index.js';
import { jwksCache } from '@adastracomputing/aer-resource-node';
import {
  createInMemoryAttestationSigner, signAttestationJwt, signingKeyIdFromPublicKey, type AttestationClaims, type Jwk,
  createInMemorySigner, signDpopProof, jwkThumbprintFromPublicKey, attestationThumbprint,
} from '@aer-oss/attestation-test-utils';

const ISS = 'https://aer-api.adastra.computer';
const AUD = 'mcp://payments-prod';
const NOW_MS = 1_780_000_000_000;
const JWKS_URL = `${ISS}/.well-known/aer-attestation-jwks.json`;

async function mint() {
  const signer = createInMemoryAttestationSigner();
  const kid = signingKeyIdFromPublicKey(signer.publicKey());
  const jwk: Jwk = { kty: 'OKP', crv: 'Ed25519', use: 'sig', alg: 'EdDSA', kid, x: Buffer.from(signer.publicKey()).toString('base64url') };
  const c: AttestationClaims = { iss: ISS, aud: AUD, sub: 'agent:a', tenant_id: 't', agent_id: 'a', agent_session_id: 's', environment_id: 'e', iat: NOW_MS / 1000, nbf: NOW_MS / 1000, exp: NOW_MS / 1000 + 300, jti: 'j' };
  return { token: await signAttestationJwt(signer, kid, c), jwk };
}
const jwksFetch = (keys: Jwk[]) => vi.fn(async () => new Response(JSON.stringify({ keys }), { status: 200, headers: { 'cache-control': 'max-age=300' } })) as unknown as typeof fetch;
const opts = (jwk: Jwk, over: Partial<GuardOptions> = {}): GuardOptions => ({ audience: AUD, issuer: ISS, jwksUrl: JWKS_URL, fetchImpl: jwksFetch([jwk]), now: () => NOW_MS, ...over });
async function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
  for (let i = 0; i < ms / 5 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
}

beforeEach(() => jwksCache.reset());

describe('honoMcpGuard', () => {
  function ctx(token?: string) {
    let stored: unknown;
    return {
      stored: () => stored,
      c: {
        req: { header: (n: string) => (n.toLowerCase() === 'x-aer-attestation' ? token : undefined) },
        set: (_k: string, v: unknown) => { stored = v; },
        json: (body: unknown, status: number) => ({ body, status }),
      },
    };
  }

  it('calls next + stores claims for a valid token', async () => {
    const { token, jwk } = await mint();
    const t = ctx(token);
    let nexted = false;
    await honoMcpGuard(opts(jwk))(t.c as never, (async () => { nexted = true; }) as never);
    expect(nexted).toBe(true);
    expect(t.stored()).toMatchObject({ agent_session_id: 's' });
  });

  it('returns a JSON-RPC 401 for a missing token without calling next', async () => {
    const { jwk } = await mint();
    const t = ctx(undefined);
    let nexted = false;
    const res = await honoMcpGuard(opts(jwk))(t.c as never, (async () => { nexted = true; }) as never) as { body: { error: { code: number } }; status: number };
    expect(nexted).toBe(false);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe(-32001);
  });
});

describe('expressMcpGuard', () => {
  function reqres(opts2: { token?: string; body?: unknown; stream?: { on: ReturnType<typeof vi.fn> } }) {
    const req = {
      header: (n: string) => (n.toLowerCase() === 'x-aer-attestation' ? (opts2.token ?? null) : null),
      body: opts2.body,
      ...(opts2.stream ?? {}),
    };
    let statusCode = 0;
    let jsonBody: unknown;
    const res = { status: (s: number) => { statusCode = s; return res; }, json: (b: unknown) => { jsonBody = b; return res; } };
    return { req, res, status: () => statusCode, json: () => jsonBody };
  }

  it('calls next + attaches claims for a valid token', async () => {
    const { token, jwk } = await mint();
    const rr = reqres({ token });
    let nexted = false;
    expressMcpGuard(opts(jwk))(rr.req as never, rr.res as never, (() => { nexted = true; }) as never);
    await waitFor(() => nexted);
    expect(nexted).toBe(true);
    expect((rr.req as unknown as { aerAttestation: { agent_session_id: string } }).aerAttestation.agent_session_id).toBe('s');
  });

  it('denies a missing token with a JSON-RPC 401', async () => {
    const { jwk } = await mint();
    const rr = reqres({});
    expressMcpGuard(opts(jwk))(rr.req as never, rr.res as never, (() => {}) as never);
    await waitFor(() => rr.status() !== 0);
    expect(rr.status()).toBe(401);
    expect((rr.json() as { error: { code: number } }).error.code).toBe(-32001);
  });

  it('echoes the JSON-RPC id from an already-parsed body', async () => {
    const { jwk } = await mint();
    const rr = reqres({ body: { jsonrpc: '2.0', id: 42, method: 'tools/call' } });
    expressMcpGuard(opts(jwk))(rr.req as never, rr.res as never, (() => {}) as never);
    await waitFor(() => rr.json() !== undefined);
    expect((rr.json() as { id: unknown }).id).toBe(42);
  });

  it('never consumes the request stream (SSE/streaming safe); id is null', async () => {
    const { jwk } = await mint();
    const on = vi.fn();
    const rr = reqres({ stream: { on } }); // no body parsed
    expressMcpGuard(opts(jwk))(rr.req as never, rr.res as never, (() => {}) as never);
    await waitFor(() => rr.json() !== undefined);
    expect(on).not.toHaveBeenCalled();         // body stream untouched
    expect((rr.json() as { id: unknown }).id).toBe(null);
  });

  describe('DPoP htu origin (Host header is spoofable)', () => {
    const RPC_ORIGIN = 'https://mcp.example.com';
    const RPC_PATH = '/rpc';
    const freshStore = () => {
      const seen = new Map<string, number>();
      return { checkAndRecord: (jti: string, exp: number) => { if (seen.has(jti)) return true; seen.set(jti, exp); return false; } };
    };

    // A DPoP-bound token whose proof htu is the REAL external origin.
    async function boundToRealOrigin() {
      const dpopSigner = createInMemorySigner();
      const jkt = jwkThumbprintFromPublicKey(dpopSigner.publicKey());
      const signer = createInMemoryAttestationSigner();
      const kid = signingKeyIdFromPublicKey(signer.publicKey());
      const jwk: Jwk = { kty: 'OKP', crv: 'Ed25519', use: 'sig', alg: 'EdDSA', kid, x: Buffer.from(signer.publicKey()).toString('base64url') };
      const c: AttestationClaims = { iss: ISS, aud: AUD, sub: 'agent:a', tenant_id: 't', agent_id: 'a', agent_session_id: 's', environment_id: 'e', iat: NOW_MS / 1000, nbf: NOW_MS / 1000, exp: NOW_MS / 1000 + 300, jti: 'j', cnf: { jkt } };
      const token = await signAttestationJwt(signer, kid, c);
      const proof = await signDpopProof(dpopSigner, { htm: 'POST', htu: `${RPC_ORIGIN}${RPC_PATH}`, iat: NOW_MS / 1000, jti: 'p-origin', ath: attestationThumbprint(token) });
      return { token, jwk, proof };
    }

    // Express req with a SPOOFED Host header — simulating an attacker who sets
    // Host to the real origin's authority while hitting a different deployment.
    function req(token: string, proof: string, spoofedHost: string) {
      return {
        method: 'POST',
        protocol: 'https',
        originalUrl: RPC_PATH,
        header: (n: string) => {
          const k = n.toLowerCase();
          if (k === 'x-aer-attestation') return token;
          if (k === 'dpop') return proof;
          if (k === 'host') return spoofedHost;
          return null;
        },
      };
    }
    const dpopOpts = (jwk: Jwk): GuardOptions =>
      opts(jwk, { requireDpop: true, replayStore: freshStore() } as Partial<GuardOptions>);

    it('admits the request when trustedOrigin is pinned (Host header ignored)', async () => {
      const { token, jwk, proof } = await boundToRealOrigin();
      let statusCode = 0; let nexted = false;
      const res = { status: (s: number) => { statusCode = s; return res; }, json: () => res };
      // Host is spoofed to something else; trustedOrigin pins the real origin.
      expressMcpGuard(dpopOpts(jwk), { trustedOrigin: RPC_ORIGIN })(
        req(token, proof, 'evil.local') as never, res as never, (() => { nexted = true; }) as never,
      );
      await waitFor(() => nexted || statusCode !== 0);
      expect(nexted).toBe(true);
      expect(statusCode).toBe(0);
    });

    it('denies the request without trustedOrigin when the Host does not match the proof', async () => {
      const { token, jwk, proof } = await boundToRealOrigin();
      let statusCode = 0; let jsonBody: unknown; let nexted = false;
      const res = { status: (s: number) => { statusCode = s; return res; }, json: (b: unknown) => { jsonBody = b; return res; } };
      // No trustedOrigin → origin derived from the spoofed Host → htu mismatch.
      expressMcpGuard(dpopOpts(jwk))(
        req(token, proof, 'evil.local') as never, res as never, (() => { nexted = true; }) as never,
      );
      await waitFor(() => statusCode !== 0);
      expect(nexted).toBe(false);
      expect(statusCode).toBe(401);
      expect((jsonBody as { error: { data: { reason: string } } }).error.data.reason).toBe('dpop_invalid');
    });
  });
});
