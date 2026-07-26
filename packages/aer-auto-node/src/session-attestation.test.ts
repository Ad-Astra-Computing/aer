import { describe, it, expect, vi } from 'vitest';
import { createSessionManager, type SessionTransport, type CollectorEvent } from './session.js';

function fakeTransport(over: Partial<SessionTransport> = {}) {
  return {
    async open() {},
    async emit(_e: CollectorEvent[]) {},
    async complete() {},
    async abort() {},
    ...over,
  } as SessionTransport;
}

const preamble = (): CollectorEvent[] => [{ event_type: 'session.started', payload: {} }];

describe('session.getAttestationFor', () => {
  it('returns null when the transport cannot mint', async () => {
    const mgr = createSessionManager({ transport: fakeTransport(), preamble });
    expect(await mgr.getAttestationFor('mcp://x')).toBeNull();
  });

  it('mints once and returns a cached token while fresh', async () => {
    let clock = 1_000_000;
    const mint = vi.fn(async (audience: string) => ({ token: `tok-${audience}`, expiresAtMs: clock + 300_000 }));
    const mgr = createSessionManager({ transport: fakeTransport({ mintAttestation: mint }), preamble, now: () => clock });

    expect(await mgr.getAttestationFor('mcp://a')).toBe('tok-mcp://a');
    clock += 60_000; // still fresh (>60s + >20% TTL remain)
    expect(await mgr.getAttestationFor('mcp://a')).toBe('tok-mcp://a');
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('passes requested scopes to the mint and keys the cache by audience + scopes', async () => {
    let clock = 1_000_000;
    const mint = vi.fn(async (audience: string, scopes?: string[]) => ({ token: `tok-${audience}-${(scopes ?? []).join('+')}`, expiresAtMs: clock + 300_000 }));
    const mgr = createSessionManager({ transport: fakeTransport({ mintAttestation: mint }), preamble, now: () => clock });

    // Same audience, different scope sets → distinct cache entries, distinct mints.
    expect(await mgr.getAttestationFor('mcp://a', ['read'])).toBe('tok-mcp://a-read');
    expect(await mgr.getAttestationFor('mcp://a', ['read', 'write'])).toBe('tok-mcp://a-read+write');
    expect(mint).toHaveBeenCalledTimes(2);
    expect(mint).toHaveBeenNthCalledWith(1, 'mcp://a', ['read']);
    // A low-scope cached token must NOT satisfy a higher-scope request.
    expect(mgr.peekAttestationFor('mcp://a', ['read'])).toBe('tok-mcp://a-read');
    expect(mgr.peekAttestationFor('mcp://a', ['read', 'write'])).toBe('tok-mcp://a-read+write');
    expect(mgr.peekAttestationFor('mcp://a', ['admin'])).toBeNull();
  });

  it('re-mints when the cached token is within the refresh window', async () => {
    let clock = 1_000_000;
    let n = 0;
    const mint = vi.fn(async () => ({ token: `tok-${++n}`, expiresAtMs: clock + 300_000 }));
    const mgr = createSessionManager({ transport: fakeTransport({ mintAttestation: mint }), preamble, now: () => clock });

    expect(await mgr.getAttestationFor('mcp://a')).toBe('tok-1');
    clock += 300_000 - 30_000; // 30s left -> within the 60s refresh window
    expect(await mgr.getAttestationFor('mcp://a')).toBe('tok-2');
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent mints for the same audience', async () => {
    const mint = vi.fn(async () => { await new Promise((r) => setTimeout(r, 10)); return { token: 'tok', expiresAtMs: Date.now() + 300_000 }; });
    const mgr = createSessionManager({ transport: fakeTransport({ mintAttestation: mint }), preamble });
    const [a, b] = await Promise.all([mgr.getAttestationFor('mcp://a'), mgr.getAttestationFor('mcp://a')]);
    expect(a).toBe('tok');
    expect(b).toBe('tok');
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('opens the session before minting (mint needs the session id)', async () => {
    const log: string[] = [];
    const transport = fakeTransport({
      open: async () => { log.push('open'); },
      mintAttestation: async () => { log.push('mint'); return { token: 't', expiresAtMs: Date.now() + 300_000 }; },
    });
    const mgr = createSessionManager({ transport, preamble });
    await mgr.getAttestationFor('mcp://a');
    expect(log).toEqual(['open', 'mint']);
  });

  it('never throws if minting fails; returns the cached token if any', async () => {
    let clock = 1_000_000;
    let ok = true;
    const mint = vi.fn(async () => { if (!ok) throw new Error('mint down'); return { token: 'tok-1', expiresAtMs: clock + 300_000 }; });
    const mgr = createSessionManager({ transport: fakeTransport({ mintAttestation: mint }), preamble, now: () => clock });

    expect(await mgr.getAttestationFor('mcp://a')).toBe('tok-1');
    clock += 300_000; // force refresh
    ok = false;
    // refresh fails -> returns the stale cached token rather than throwing
    await expect(mgr.getAttestationFor('mcp://a')).resolves.toBe('tok-1');
  });

  it('stops minting and clears the cache after the session completes', async () => {
    const mint = vi.fn(async () => ({ token: 't', expiresAtMs: Date.now() + 300_000 }));
    const mgr = createSessionManager({ transport: fakeTransport({ mintAttestation: mint }), preamble });
    mgr.capture({ event_type: 'http.requested', payload: {} });
    await mgr.getAttestationFor('mcp://a');
    await mgr.complete();
    expect(await mgr.getAttestationFor('mcp://a')).toBeNull();
  });
});

describe('session DPoP (M3)', () => {
  const fakeKey = () => ({ jkt: 'JKT-abc', proof: vi.fn((a: { method: string; url: string; token: string }) => `proof:${a.method}:${a.url}:${a.token}`) });

  it('binds the mint to the session DPoP key when dpop=true (passes dpop_jkt)', async () => {
    const mint = vi.fn(async (_a: string, _s?: string[], jkt?: string) => ({ token: `tok-${jkt ?? 'none'}`, expiresAtMs: Date.now() + 300_000 }));
    const key = fakeKey();
    const mgr = createSessionManager({ transport: fakeTransport({ mintAttestation: mint }), preamble, dpopKeyFactory: () => key });

    expect(await mgr.getAttestationFor('mcp://a', [], true)).toBe('tok-JKT-abc');
    expect(mint).toHaveBeenCalledWith('mcp://a', [], 'JKT-abc');
  });

  it('keys the cache separately for dpop vs bearer on the same audience', async () => {
    let n = 0;
    const mint = vi.fn(async (_a: string, _s?: string[], jkt?: string) => ({ token: `t${++n}-${jkt ? 'd' : 'b'}`, expiresAtMs: Date.now() + 300_000 }));
    const mgr = createSessionManager({ transport: fakeTransport({ mintAttestation: mint }), preamble, dpopKeyFactory: () => fakeKey() });

    const bearer = await mgr.getAttestationFor('mcp://a', [], false);
    const bound = await mgr.getAttestationFor('mcp://a', [], true);
    expect(bearer).not.toBe(bound);
    expect(mint).toHaveBeenCalledTimes(2);
    // each is independently cached
    expect(mgr.peekAttestationFor('mcp://a', [], false)).toBe(bearer);
    expect(mgr.peekAttestationFor('mcp://a', [], true)).toBe(bound);
  });

  it('dpopProofFor signs a proof with the session key, null after close', async () => {
    const key = fakeKey();
    const mgr = createSessionManager({ transport: fakeTransport(), preamble, dpopKeyFactory: () => key, now: () => 5_000 });
    mgr.capture({ event_type: 'http.requested', payload: {} });

    const proof = mgr.dpopProofFor('POST', 'https://mcp/x', 'the-token');
    expect(proof).toBe('proof:POST:https://mcp/x:the-token');
    expect(key.proof).toHaveBeenCalledWith({ method: 'POST', url: 'https://mcp/x', token: 'the-token', nowSec: 5 });

    await mgr.complete();
    expect(mgr.dpopProofFor('POST', 'https://mcp/x', 'the-token')).toBeNull();
  });
});
