import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  verifyAttestation, AttestationError, jwksCache, introspectionCache, createMemoryReplayStore,
  thumbprintFromPeerCert, thumbprintFromForwardedClientCert, DEFAULT_ISSUER, DEFAULT_JWKS_URL,
  type Jwk, type ReplayStore,
} from './index.js';
import { honoAerAttestation, type MiddlewareOptions } from './hono.js';
import { expressAerAttestation, type MiddlewareOptions as ExpressMiddlewareOptions } from './express.js';
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

  it('caches JWKS: a second verify does not refetch', async () => {
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

describe('verifyAttestation rejects a non-string token', () => {
  // A direct caller can hand over null from a missed lookup. Denying with a
  // structured AttestationError keeps the reason mappable to a status code,
  // where a TypeError is not.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 12345],
    ['an object', {}],
  ])('denies %s with malformed', async (_label, token) => {
    await expect(
      verifyAttestation(token as unknown as string, { audience: 'mcp://x' }),
    ).rejects.toMatchObject({ code: 'malformed' });
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

// The hono/express wrappers build a single static options object at
// middleware-creation time, outside any request. requireDpop needs the REAL
// per-request method, URL and DPoP header, which only exist inside the
// request handler - this suite proves each wrapper wires them through
// per-request, not from a value fixed at setup time.
describe('requireDpop through the middleware wrappers', () => {
  const RPC_ORIGIN = 'https://payments.example.com';
  const RPC_PATH = '/charge';
  const freshStore = (): ReplayStore => {
    const seen = new Map<string, number>();
    return { checkAndRecord: (jti, exp) => { if (seen.has(jti)) return true; seen.set(jti, exp); return false; } };
  };

  async function boundToOrigin(jti: string) {
    const dpopSigner = createInMemorySigner();
    const jkt = jwkThumbprintFromPublicKey(dpopSigner.publicKey());
    const { token, jwk } = await mint({ cnf: { jkt } });
    const proof = await signDpopProof(dpopSigner, {
      htm: 'POST', htu: `${RPC_ORIGIN}${RPC_PATH}`, iat: NOW_S, jti, ath: attestationThumbprint(token),
    });
    return { token, jwk, proof };
  }
  const dpopOpts = (jwk: Jwk) => opts(jwk, jwksFetch([jwk]), { requireDpop: true, replayStore: freshStore() });

  describe('honoAerAttestation', () => {
    it('throws at setup when requireDpop is set without trustedOrigin', async () => {
      const { jwk } = await mint();
      expect(() => honoAerAttestation(dpopOpts(jwk))).toThrow(/trustedOrigin/);
    });

    function ctx(token: string, proof: string, method: string, url: string) {
      let body: unknown; let status = 0;
      return {
        status: () => status,
        c: {
          req: {
            method, url,
            header: (n: string) => {
              const k = n.toLowerCase();
              if (k === 'x-aer-attestation') return token;
              if (k === 'dpop') return proof;
              return undefined;
            },
          },
          set: () => {},
          json: (b: unknown, s: number) => { body = b; status = s; return { body: b, status: s }; },
        },
      };
    }

    it('admits a request whose proof is bound to its real method + URL', async () => {
      const { token, jwk, proof } = await boundToOrigin('hono-ok');
      const t = ctx(token, proof, 'POST', `${RPC_ORIGIN}${RPC_PATH}`);
      let nexted = false;
      await honoAerAttestation(dpopOpts(jwk), { trustedOrigin: RPC_ORIGIN })(t.c as never, (async () => { nexted = true; }) as never);
      expect(nexted).toBe(true);
      expect(t.status()).toBe(0);
    });

    // A forged-context replay: the proof was bound to a different method. A
    // middleware that still passed a static (or absent) method/url through
    // would never catch this.
    it('denies a proof bound to a different method', async () => {
      const { token, jwk, proof } = await boundToOrigin('hono-method');
      const t = ctx(token, proof, 'GET', `${RPC_ORIGIN}${RPC_PATH}`);
      let nexted = false;
      await honoAerAttestation(dpopOpts(jwk), { trustedOrigin: RPC_ORIGIN })(t.c as never, (async () => { nexted = true; }) as never);
      expect(nexted).toBe(false);
      expect(t.status()).toBe(403);
    });

    // A forged-context replay: the proof was bound to a different path. The
    // spoofable Host from c.req.url is ignored once trustedOrigin is pinned.
    it('denies a proof bound to a different URL, even with Host spoofed to the real origin', async () => {
      const { token, jwk, proof } = await boundToOrigin('hono-url');
      const t = ctx(token, proof, 'POST', `https://${new URL(RPC_ORIGIN).host}/other`);
      let nexted = false;
      await honoAerAttestation(dpopOpts(jwk), { trustedOrigin: RPC_ORIGIN })(t.c as never, (async () => { nexted = true; }) as never);
      expect(nexted).toBe(false);
      expect(t.status()).toBe(403);
    });
  });

  describe('expressAerAttestation', () => {
    async function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
      for (let i = 0; i < ms / 5 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
    }

    it('throws at setup when requireDpop is set without trustedOrigin', async () => {
      const { jwk } = await mint();
      expect(() => expressAerAttestation(dpopOpts(jwk))).toThrow(/trustedOrigin/);
    });

    function reqres(token: string, proof: string, method: string, originalUrl: string, hostHeader: string) {
      const req = {
        method,
        protocol: 'https',
        originalUrl,
        header: (n: string) => {
          const k = n.toLowerCase();
          if (k === 'x-aer-attestation') return token;
          if (k === 'dpop') return proof;
          if (k === 'host') return hostHeader;
          return null;
        },
      };
      let statusCode = 0; let jsonBody: unknown;
      const res = { status: (s: number) => { statusCode = s; return res; }, json: (b: unknown) => { jsonBody = b; return res; } };
      return { req, res, status: () => statusCode, json: () => jsonBody };
    }

    it('admits a request whose proof is bound to its real method + URL', async () => {
      const { token, jwk, proof } = await boundToOrigin('express-ok');
      const rr = reqres(token, proof, 'POST', RPC_PATH, new URL(RPC_ORIGIN).host);
      let nexted = false;
      expressAerAttestation(dpopOpts(jwk), { trustedOrigin: RPC_ORIGIN })(rr.req as never, rr.res as never, (() => { nexted = true; }) as never);
      await waitFor(() => nexted || rr.status() !== 0);
      expect(nexted).toBe(true);
      expect(rr.status()).toBe(0);
    });

    it('denies a proof bound to a different method', async () => {
      const { token, jwk, proof } = await boundToOrigin('express-method');
      const rr = reqres(token, proof, 'GET', RPC_PATH, new URL(RPC_ORIGIN).host);
      let nexted = false;
      expressAerAttestation(dpopOpts(jwk), { trustedOrigin: RPC_ORIGIN })(rr.req as never, rr.res as never, (() => { nexted = true; }) as never);
      await waitFor(() => rr.status() !== 0);
      expect(nexted).toBe(false);
      expect(rr.status()).toBe(403);
    });

    // Host header spoofed to the real origin's authority, while the request
    // path differs from the one the proof was bound to.
    it('denies a proof bound to a different URL, even with Host spoofed to the real origin', async () => {
      const { token, jwk, proof } = await boundToOrigin('express-url');
      const rr = reqres(token, proof, 'POST', '/other', new URL(RPC_ORIGIN).host);
      let nexted = false;
      expressAerAttestation(dpopOpts(jwk), { trustedOrigin: RPC_ORIGIN })(rr.req as never, rr.res as never, (() => { nexted = true; }) as never);
      await waitFor(() => rr.status() !== 0);
      expect(nexted).toBe(false);
      expect(rr.status()).toBe(403);
    });

    // Without a pinned trustedOrigin, requireDpop must refuse to construct at
    // all - deriving htu from the Host header would let a captured proof be
    // replayed across deployments by spoofing Host to the proof's real origin.
    it('a request bound to a different deployment (unpinned fallback) is never reachable: setup throws', () => {
      const jwk: Jwk = { kty: 'OKP', crv: 'Ed25519', kid: 'x', x: 'AAAA' };
      expect(() => expressAerAttestation(dpopOpts(jwk))).toThrow(/trustedOrigin/);
    });

    // A malformed request-target must deny (403), never escape the try as an
    // uncaught synchronous throw (would otherwise become an attacker-
    // triggerable 500, and contradict failOpen).
    it('denies rather than throws on a request-target the URL parser rejects', async () => {
      const { jwk } = await mint();
      const req = {
        method: 'POST',
        protocol: 'https',
        originalUrl: 'http://[not-a-host/x', // unparseable authority
        header: (n: string) => (n.toLowerCase() === 'host' ? new URL(RPC_ORIGIN).host : null),
      };
      let statusCode = 0; let threw: unknown;
      const res = { status: (s: number) => { statusCode = s; return res; }, json: () => res };
      try {
        expressAerAttestation(opts(jwk, jwksFetch([jwk])))(req as never, res as never, (() => {}) as never);
        await waitFor(() => statusCode !== 0);
      } catch (err) { threw = err; }
      expect(threw).toBeUndefined();
      expect(statusCode).toBe(403);
    });

    // The htu derived for a plain, single-slash request must match the path
    // Express itself routes on - no `//`-authority reinterpretation.
    it('binds htu to the verbatim origin-form path, not a URL-reparsed one', async () => {
      const { token, jwk, proof } = await boundToOrigin('express-verbatim-path');
      // boundToOrigin binds the proof to RPC_PATH ("/charge"); a request whose
      // originalUrl carries a query string must still match on path alone.
      const rr = reqres(token, proof, 'POST', `${RPC_PATH}?x=1`, new URL(RPC_ORIGIN).host);
      let nexted = false;
      expressAerAttestation(dpopOpts(jwk), { trustedOrigin: RPC_ORIGIN })(rr.req as never, rr.res as never, (() => { nexted = true; }) as never);
      await waitFor(() => nexted || rr.status() !== 0);
      expect(nexted).toBe(true);
      expect(rr.status()).toBe(0);
    });
  });

  describe('requireMtls is refused through the middleware (no per-request thumbprint to check against)', () => {
    it('hono: throws at setup, even for a plain-JS caller the type system would not catch', async () => {
      const { jwk } = await mint();
      const unchecked = { ...opts(jwk, jwksFetch([jwk])), requireMtls: true } as unknown as MiddlewareOptions;
      expect(() => honoAerAttestation(unchecked)).toThrow(/requireMtls/);
    });

    it('express: throws at setup, even for a plain-JS caller the type system would not catch', async () => {
      const { jwk } = await mint();
      const unchecked = { ...opts(jwk, jwksFetch([jwk])), requireMtls: true } as unknown as ExpressMiddlewareOptions;
      expect(() => expressAerAttestation(unchecked)).toThrow(/requireMtls/);
    });
  });

  describe('trustedOrigin validation', () => {
    it('hono: throws at setup on a trustedOrigin that is not a bare origin', async () => {
      const { jwk } = await mint();
      expect(() => honoAerAttestation(dpopOpts(jwk), { trustedOrigin: 'not a url' })).toThrow(/trustedOrigin/);
      expect(() => honoAerAttestation(dpopOpts(jwk), { trustedOrigin: `${RPC_ORIGIN}/base` })).toThrow(/trustedOrigin/);
      expect(() => honoAerAttestation(dpopOpts(jwk), { trustedOrigin: `${RPC_ORIGIN}?x=1` })).toThrow(/trustedOrigin/);
    });

    it('express: throws at setup on a trustedOrigin that is not a bare origin', async () => {
      const { jwk } = await mint();
      expect(() => expressAerAttestation(dpopOpts(jwk), { trustedOrigin: 'not a url' })).toThrow(/trustedOrigin/);
      expect(() => expressAerAttestation(dpopOpts(jwk), { trustedOrigin: `${RPC_ORIGIN}/base` })).toThrow(/trustedOrigin/);
    });

    it('accepts a bare origin with a trailing slash', async () => {
      const { jwk } = await mint();
      expect(() => honoAerAttestation(dpopOpts(jwk), { trustedOrigin: `${RPC_ORIGIN}/` })).not.toThrow();
    });
  });

  describe('failOpen reports the denial reason via onFailOpen', () => {
    it('hono', async () => {
      const { jwk } = await mint();
      let reported: string | undefined;
      const mw = honoAerAttestation({ ...opts(jwk, jwksFetch([jwk])), failOpen: true, onFailOpen: (r) => { reported = r; } });
      let nexted = false;
      const c = { req: { header: () => undefined }, set: () => {}, json: () => ({}) };
      await mw(c as never, (async () => { nexted = true; }) as never);
      expect(nexted).toBe(true);
      expect(reported).toBe('missing_token');
    });

    it('express', async () => {
      const { jwk } = await mint();
      let reported: string | undefined;
      const req = { header: () => null };
      let nexted = false;
      const res = { status: () => res, json: () => res };
      expressAerAttestation({ ...opts(jwk, jwksFetch([jwk])), failOpen: true, onFailOpen: (r) => { reported = r; } })(
        req as never, res as never, (() => { nexted = true; }) as never,
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(nexted).toBe(true);
      expect(reported).toBe('missing_token');
    });
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

  it('does not grow the introspection cache without bound across many distinct tokens', async () => {
    // One process-local cache is keyed by raw token. A long-running resource
    // server that introspects many distinct tokens over its lifetime must not
    // accumulate one entry per token forever. Same signer/jwk throughout (only
    // `jti` varies) so this exercises the introspection cache in isolation,
    // not JWKS refetch behavior.
    const signer = createInMemoryAttestationSigner();
    const kid = signingKeyIdFromPublicKey(signer.publicKey());
    const jwk: Jwk = { kty: 'OKP', crv: 'Ed25519', use: 'sig', alg: 'EdDSA', kid, x: Buffer.from(signer.publicKey()).toString('base64url') };
    const impl = introspectFetch({ active: true });
    const N = 3000;
    for (let i = 0; i < N; i++) {
      const now = NOW_MS + i * 1000; // 1s apart; default active-verdict TTL is 10s
      const nowSec = Math.floor(now / 1000);
      const token = await signAttestationJwt(signer, kid, claims({ jti: `j-${i}`, iat: nowSec, nbf: nowSec, exp: nowSec + 300 }));
      await verifyAttestation(token, opts(jwk, jwksFetch([jwk]), {
        now: () => now,
        introspect: { url: INTROSPECT_URL, verifierKey: 'aerv_test', fetchImpl: impl },
      }));
    }
    // Reaching into the private field is the only way to observe memory
    // growth without changing the public API surface.
    const size = (introspectionCache as unknown as { entries: Map<string, unknown> }).entries.size;
    expect(size).toBeLessThan(N);
    expect(size).toBeLessThan(600); // well under one entry per distinct token seen
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

describe('defaults', () => {
  it('DEFAULT_ISSUER stays the attestation issuer identifier, not a fetchable URL', () => {
    expect(DEFAULT_ISSUER).toBe('https://aer-api.adastra.computer');
  });

  it('DEFAULT_JWKS_URL points at the canonical api.aer.run JWKS endpoint', () => {
    expect(DEFAULT_JWKS_URL).toBe('https://api.aer.run/.well-known/aer-attestation-jwks.json');
  });
});

// AGENTS.md: "Fail closed. An unreachable JWKS is a denial." The cache used
// to keep serving an expired JWKS when the refetch failed, and every outage
// was reported as unknown_kid, which reads as a forged or rotated token.
describe('JWKS outages', () => {
  const down = (kind: 'reject' | '503' | 'html' | 'shape') => vi.fn(async () => {
    if (kind === 'reject') throw new TypeError('fetch failed');
    if (kind === '503') return new Response('unavailable', { status: 503 });
    if (kind === 'html') return new Response('<html>login</html>', { status: 200 });
    return new Response(JSON.stringify({ keys: { not: 'an array' } }), { status: 200 });
  }) as unknown as typeof fetch;

  for (const kind of ['reject', '503', 'html', 'shape'] as const) {
    it(`denies with jwks_unavailable on a cold cache when the JWKS ${kind === 'reject' ? 'is unreachable' : kind === '503' ? 'answers 503' : kind === 'html' ? 'is not JSON' : 'has no key list'}`, async () => {
      const { token, jwk } = await mint();
      await expect(verifyAttestation(token, opts(jwk, down(kind)))).rejects.toMatchObject({ code: 'jwks_unavailable' });
    });
  }

  it('denies once the cached JWKS has expired and the refetch fails', async () => {
    const { token, jwk } = await mint();
    let now = NOW_MS;
    const ok = vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'cache-control': 'max-age=60' } })) as unknown as typeof fetch;
    await expect(verifyAttestation(token, opts(jwk, ok, { now: () => now }))).resolves.toBeTruthy();
    now = NOW_MS + 61_000;
    await expect(verifyAttestation(token, opts(jwk, down('reject'), { now: () => now }))).rejects.toMatchObject({ code: 'jwks_unavailable' });
  });

  it('still verifies from a cache within its max-age without refetching', async () => {
    const { token, jwk } = await mint();
    let now = NOW_MS;
    const ok = vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'cache-control': 'max-age=60' } })) as unknown as typeof fetch;
    await verifyAttestation(token, opts(jwk, ok, { now: () => now }));
    now = NOW_MS + 30_000;
    const failing = down('reject');
    await expect(verifyAttestation(token, opts(jwk, failing, { now: () => now }))).resolves.toBeTruthy();
    expect(failing).not.toHaveBeenCalled();
  });

  it('an unknown kid with the JWKS unreachable is jwks_unavailable, with it reachable unknown_kid', async () => {
    const { jwk } = await mint();
    const other = await mint();
    let now = NOW_MS;
    const ok = vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'cache-control': 'max-age=600' } })) as unknown as typeof fetch;
    await expect(verifyAttestation(other.token, opts(jwk, ok, { now: () => now }))).rejects.toMatchObject({ code: 'unknown_kid' });
    now = NOW_MS + 20_000; // past the refetch rate limit, cache still fresh
    await expect(verifyAttestation(other.token, opts(jwk, down('503'), { now: () => now }))).rejects.toMatchObject({ code: 'jwks_unavailable' });
  });
});

// CVE-2026-111497: fetch() decodes a Brotli body lazily on first read, and a
// hostile server picks Content-Encoding regardless of what was requested.
// The JWKS and introspection endpoints are external HTTP servers this
// process does not control the bytes of.
describe('CVE-2026-111497: compressed responses are refused unread', () => {
  it('a compressed JWKS response is jwks_unavailable, and its body is never read', async () => {
    const { token, jwk } = await mint();
    let bodyRead = false;
    const res = new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-encoding': 'br' } });
    res.json = (async () => { bodyRead = true; return { keys: [jwk] }; }) as typeof res.json;
    const impl = vi.fn(async () => res) as unknown as typeof fetch;
    await expect(verifyAttestation(token, opts(jwk, impl))).rejects.toMatchObject({ code: 'jwks_unavailable' });
    expect(bodyRead).toBe(false);
  });

  it('a compressed introspection response is introspection_unavailable, and its body is never read', async () => {
    const { token, jwk } = await mint();
    let bodyRead = false;
    const res = new Response(JSON.stringify({ active: true }), { status: 200, headers: { 'content-encoding': 'br' } });
    res.json = (async () => { bodyRead = true; return { active: true }; }) as typeof res.json;
    const impl = vi.fn(async () => res) as unknown as typeof fetch;
    const withOpts = opts(jwk, jwksFetch([jwk]), { introspect: { url: INTROSPECT_URL, verifierKey: 'aerv_test', fetchImpl: impl } });
    await expect(verifyAttestation(token, withOpts)).rejects.toMatchObject({ code: 'introspection_unavailable' });
    expect(bodyRead).toBe(false);
  });
});
