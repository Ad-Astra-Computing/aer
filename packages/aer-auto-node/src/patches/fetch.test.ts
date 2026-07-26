import { describe, it, expect, vi, afterEach } from 'vitest';
import { installFetchPatch } from './fetch.js';
import type { CollectorEvent } from '../session.js';
import { createAttestor, type Attestor } from '../attestor.js';
import type { EgressEnforcement, EgressOnUnavailable } from '../config.js';

/**
 * Attestor for the patch tests — the REAL createAttestor wired to a fixed token,
 * so resourceFor / evaluateEgress / counters are exercised end to end. Defaults
 * to enforcement 'off' (today's additive behavior).
 */
function fakeAttestor(opts: {
  host: string;
  audience?: string;
  token: string | null;
  scopes?: string[];
  enforcement?: EgressEnforcement;
  onUnavailable?: EgressOnUnavailable;
  dpop?: boolean;
}): Attestor {
  const resource = {
    host: opts.host,
    audience: opts.audience ?? 'mcp://aud',
    scopes: opts.scopes ?? [],
    enforcement: opts.enforcement ?? ('off' as const),
    onUnavailable: opts.onUnavailable ?? ('fail_closed' as const),
    dpop: opts.dpop ?? false,
  };
  return createAttestor({
    resources: [resource],
    getAttestationFor: async () => opts.token,
    peekAttestationFor: () => opts.token,
  });
}

function headerFromCall(orig: ReturnType<typeof vi.fn>): string | null {
  const [input, init] = orig.mock.calls[0] ?? [];
  const src = (init as RequestInit | undefined)?.headers
    ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined);
  return new Headers(src as ConstructorParameters<typeof Headers>[0]).get('x-aer-attestation');
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  // Clear the global patch guards so a test that throws before uninstall()
  // can't leak the patched state into the next test.
  const g = globalThis as Record<symbol, unknown>;
  delete g[Symbol.for('adastra.aer.patched.fetch')];
  delete g[Symbol.for('adastra.aer.original.fetch')];
});

function withCapture() {
  const events: CollectorEvent[] = [];
  return { capture: (e: CollectorEvent) => events.push(e), events };
}

describe('installFetchPatch', () => {
  it('emits http.requested then http.completed around a successful fetch', async () => {
    const orig = vi.fn(async () => new Response('ok', { status: 200 }));
    globalThis.fetch = orig as unknown as typeof fetch;
    const { capture, events } = withCapture();

    const uninstall = installFetchPatch(capture);
    const res = await globalThis.fetch('https://api.openai.com/v1/chat?key=secret', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(orig).toHaveBeenCalledOnce();
    const types = events.map((e) => e.event_type);
    expect(types).toEqual(['http.requested', 'http.completed']);
    expect(events[0]?.payload).toMatchObject({ host: 'api.openai.com', method: 'POST' });
    expect(events[1]?.payload).toMatchObject({ host: 'api.openai.com', status: 200 });
    uninstall();
  });

  it('redacts the query string (no secrets in path_redacted)', async () => {
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const { capture, events } = withCapture();
    const uninstall = installFetchPatch(capture);
    await globalThis.fetch('https://x.test/users?token=abc123&id=7');
    const req = events.find((e) => e.event_type === 'http.requested');
    expect(String(req?.payload['path_redacted'])).not.toContain('abc123');
    expect(String(req?.payload['path_redacted'])).toContain('/users');
    uninstall();
  });

  it('still emits http.completed (and rethrows) when the underlying fetch rejects', async () => {
    globalThis.fetch = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    const { capture, events } = withCapture();
    const uninstall = installFetchPatch(capture);
    await expect(globalThis.fetch('https://x.test/')).rejects.toThrow('network down');
    const completed = events.find((e) => e.event_type === 'http.completed');
    expect(completed?.payload['error']).toBe(true);
    uninstall();
  });

  it('is idempotent — double install does not double-wrap', async () => {
    const orig = vi.fn(async () => new Response('', { status: 200 }));
    globalThis.fetch = orig as unknown as typeof fetch;
    const { capture, events } = withCapture();
    const u1 = installFetchPatch(capture);
    const u2 = installFetchPatch(capture);
    await globalThis.fetch('https://x.test/');
    expect(events.filter((e) => e.event_type === 'http.requested')).toHaveLength(1);
    u1(); u2();
  });

  it('uninstall restores the original fetch', async () => {
    const orig = vi.fn(async () => new Response('', { status: 200 }));
    globalThis.fetch = orig as unknown as typeof fetch;
    const { capture } = withCapture();
    const uninstall = installFetchPatch(capture);
    uninstall();
    expect(globalThis.fetch).toBe(orig);
  });

  it('never breaks the host fetch even if capture throws', async () => {
    const orig = vi.fn(async () => new Response('ok', { status: 200 }));
    globalThis.fetch = orig as unknown as typeof fetch;
    const uninstall = installFetchPatch(() => { throw new Error('capture boom'); });
    await expect(globalThis.fetch('https://x.test/')).resolves.toBeInstanceOf(Response);
    uninstall();
  });

  describe('attestation injection', () => {
    it('injects X-AER-Attestation for an https request to a configured protected host', async () => {
      const orig = vi.fn(async () => new Response('', { status: 200 }));
      globalThis.fetch = orig as unknown as typeof fetch;
      const { capture } = withCapture();
      const att = fakeAttestor({ host: 'mcp.internal', token: 'jwt-1' });
      const uninstall = installFetchPatch(capture, att);

      await globalThis.fetch('https://mcp.internal/tools', { method: 'POST' });

      expect(headerFromCall(orig)).toBe('jwt-1');
      expect(att.stats.injected).toBe(1);
      // caller's original init is untouched (fresh object passed to fetch)
      uninstall();
    });

    it('injects when the input is a Request object', async () => {
      const orig = vi.fn(async () => new Response('', { status: 200 }));
      globalThis.fetch = orig as unknown as typeof fetch;
      const att = fakeAttestor({ host: 'mcp.internal', token: 'jwt-req' });
      const uninstall = installFetchPatch(() => {}, att);

      await globalThis.fetch(new Request('https://mcp.internal/x'));

      expect(headerFromCall(orig)).toBe('jwt-req');
      expect(att.stats.injected).toBe(1);
      expect(att.stats.redirect_manual_fallback).toBe(1); // Request body is one-shot -> no-follow
      uninstall();
    });

    it('does NOT inject for a host that is not a configured protected resource', async () => {
      const orig = vi.fn(async () => new Response('', { status: 200 }));
      globalThis.fetch = orig as unknown as typeof fetch;
      const att = fakeAttestor({ host: 'mcp.internal', token: 'jwt-1' });
      const uninstall = installFetchPatch(() => {}, att);

      await globalThis.fetch('https://api.openai.com/v1/chat');

      expect(headerFromCall(orig)).toBeNull();
      expect(att.stats.injected).toBe(0);
      uninstall();
    });

    it('does NOT inject over plain http (TLS required)', async () => {
      const orig = vi.fn(async () => new Response('', { status: 200 }));
      globalThis.fetch = orig as unknown as typeof fetch;
      const att = fakeAttestor({ host: 'mcp.internal', token: 'jwt-1' });
      const uninstall = installFetchPatch(() => {}, att);

      await globalThis.fetch('http://mcp.internal/tools');

      expect(headerFromCall(orig)).toBeNull();
      expect(att.stats.injected).toBe(0);
      uninstall();
    });

    it('does NOT overwrite a caller-supplied X-AER-Attestation header', async () => {
      const orig = vi.fn(async () => new Response('', { status: 200 }));
      globalThis.fetch = orig as unknown as typeof fetch;
      const att = fakeAttestor({ host: 'mcp.internal', token: 'jwt-mine' });
      const uninstall = installFetchPatch(() => {}, att);

      await globalThis.fetch('https://mcp.internal/x', { headers: { 'X-AER-Attestation': 'caller-token' } });

      expect(headerFromCall(orig)).toBe('caller-token');
      expect(att.stats.injected).toBe(0);
      uninstall();
    });

    it('proceeds without a header (no throw) when no token is available', async () => {
      const orig = vi.fn(async () => new Response('', { status: 200 }));
      globalThis.fetch = orig as unknown as typeof fetch;
      const att = fakeAttestor({ host: 'mcp.internal', token: null });
      const uninstall = installFetchPatch(() => {}, att);

      await expect(globalThis.fetch('https://mcp.internal/x')).resolves.toBeInstanceOf(Response);
      expect(headerFromCall(orig)).toBeNull();
      expect(att.stats.injected).toBe(0);
      uninstall();
    });

    it('no attestor => never injects (zero-overhead path)', async () => {
      const orig = vi.fn(async () => new Response('', { status: 200 }));
      globalThis.fetch = orig as unknown as typeof fetch;
      const uninstall = installFetchPatch(() => {});
      await globalThis.fetch('https://mcp.internal/x');
      expect(headerFromCall(orig)).toBeNull();
      uninstall();
    });
  });

  describe('egress enforcement (M2)', () => {
    const tokenWithScopes = (scp: string[]) => {
      const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
      return `h.${b64({ scp })}.s`;
    };

    it('block + no token: denies with a synthetic 403, never calls the original fetch', async () => {
      const orig = vi.fn(async () => new Response('ok', { status: 200 }));
      globalThis.fetch = orig as unknown as typeof fetch;
      const { capture, events } = withCapture();
      const att = fakeAttestor({ host: 'mcp.internal', token: null, enforcement: 'block' });
      const uninstall = installFetchPatch(capture, att);

      const res = await globalThis.fetch('https://mcp.internal/tools', { method: 'POST' });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'aer_egress_blocked', reason: 'unavailable' });
      expect(orig).not.toHaveBeenCalled(); // no request body left the process
      expect(events.map((e) => e.event_type)).toContain('egress.blocked');
      expect(att.stats.egress_blocked).toBe(1);
      uninstall();
    });

    it('block + token missing a required scope: denies 403 insufficient_scope, no original call', async () => {
      const orig = vi.fn(async () => new Response('ok', { status: 200 }));
      globalThis.fetch = orig as unknown as typeof fetch;
      const { capture } = withCapture();
      const att = fakeAttestor({ host: 'mcp.internal', token: tokenWithScopes(['payments.read']), enforcement: 'block', scopes: ['payments.write'] });
      const uninstall = installFetchPatch(capture, att);

      const res = await globalThis.fetch('https://mcp.internal/x');

      expect(res.status).toBe(403);
      expect((await res.json()).reason).toBe('insufficient_scope');
      expect(orig).not.toHaveBeenCalled();
      expect(att.stats.egress_insufficient_scope).toBe(1);
      uninstall();
    });

    it('block + valid token covering scopes: allows and injects the token', async () => {
      const orig = vi.fn(async () => new Response('ok', { status: 200 }));
      globalThis.fetch = orig as unknown as typeof fetch;
      const token = tokenWithScopes(['payments.read']);
      const att = fakeAttestor({ host: 'mcp.internal', token, enforcement: 'block', scopes: ['payments.read'] });
      const uninstall = installFetchPatch(() => {}, att);

      const res = await globalThis.fetch('https://mcp.internal/x');

      expect(res.status).toBe(200);
      expect(orig).toHaveBeenCalledOnce();
      expect(headerFromCall(orig)).toBe(token);
      uninstall();
    });

    it('report + no token: sends the request, emits egress.would_block (no block)', async () => {
      const orig = vi.fn(async () => new Response('ok', { status: 200 }));
      globalThis.fetch = orig as unknown as typeof fetch;
      const { capture, events } = withCapture();
      const att = fakeAttestor({ host: 'mcp.internal', token: null, enforcement: 'report' });
      const uninstall = installFetchPatch(capture, att);

      const res = await globalThis.fetch('https://mcp.internal/x');

      expect(res.status).toBe(200);
      expect(orig).toHaveBeenCalledOnce();
      expect(events.map((e) => e.event_type)).toContain('egress.would_block');
      expect(att.stats.egress_would_block).toBe(1);
      uninstall();
    });

    it('block + fail_open + no token: allows the request, emits would_block', async () => {
      const orig = vi.fn(async () => new Response('ok', { status: 200 }));
      globalThis.fetch = orig as unknown as typeof fetch;
      const { capture, events } = withCapture();
      const att = fakeAttestor({ host: 'mcp.internal', token: null, enforcement: 'block', onUnavailable: 'fail_open' });
      const uninstall = installFetchPatch(capture, att);

      const res = await globalThis.fetch('https://mcp.internal/x');

      expect(res.status).toBe(200);
      expect(orig).toHaveBeenCalledOnce();
      expect(events.map((e) => e.event_type)).toContain('egress.would_block');
      expect(att.stats.egress_unavailable_fail_open).toBe(1);
      uninstall();
    });

    it('mints with the MATCHED host scopes when two resources share an audience', async () => {
      // Scope must follow the matched resource, not the first one
      // that shares the audience.
      const orig = vi.fn(async () => new Response('ok', { status: 200 }));
      globalThis.fetch = orig as unknown as typeof fetch;
      const mint = vi.fn(async () => 'h..s');
      const att = createAttestor({
        resources: [
          { host: 'a.test', audience: 'mcp://shared', scopes: ['read'], enforcement: 'off', onUnavailable: 'fail_closed', dpop: false },
          { host: 'b.test', audience: 'mcp://shared', scopes: ['write'], enforcement: 'off', onUnavailable: 'fail_closed', dpop: false },
        ],
        getAttestationFor: mint,
        peekAttestationFor: () => null,
      });
      const uninstall = installFetchPatch(() => {}, att);

      await globalThis.fetch('https://a.test/x');
      await globalThis.fetch('https://b.test/x');

      expect(mint).toHaveBeenNthCalledWith(1, 'mcp://shared', ['read'], false);
      expect(mint).toHaveBeenNthCalledWith(2, 'mcp://shared', ['write'], false);
      uninstall();
    });

    it('attaches a DPoP header and forces manual redirect for a dpop resource', async () => {
      const orig = vi.fn(async () => new Response('', { status: 200 }));
      globalThis.fetch = orig as unknown as typeof fetch;
      const att = createAttestor({
        resources: [{ host: 'mcp.internal', audience: 'mcp://aud', scopes: [], enforcement: 'off', onUnavailable: 'fail_closed', dpop: true }],
        getAttestationFor: async () => 'jwt-1',
        peekAttestationFor: () => 'jwt-1',
        dpopProofFor: (m, u, t) => `proof:${m}:${u}:${t}`,
      });
      const uninstall = installFetchPatch(() => {}, att);

      await globalThis.fetch('https://mcp.internal/tools?x=1', { method: 'POST' });

      const [, init] = orig.mock.calls[0]!;
      const h = new Headers((init as RequestInit).headers as ConstructorParameters<typeof Headers>[0]);
      expect(h.get('x-aer-attestation')).toBe('jwt-1');
      expect(h.get('dpop')).toBe('proof:POST:https://mcp.internal/tools?x=1:jwt-1');
      expect((init as RequestInit).redirect).toBe('manual'); // never auto-follow with a bound proof
      uninstall();
    });

    it('block mode never affects a non-protected host', async () => {
      const orig = vi.fn(async () => new Response('ok', { status: 200 }));
      globalThis.fetch = orig as unknown as typeof fetch;
      const att = fakeAttestor({ host: 'mcp.internal', token: null, enforcement: 'block' });
      const uninstall = installFetchPatch(() => {}, att);

      const res = await globalThis.fetch('https://api.openai.com/v1/chat');

      expect(res.status).toBe(200);
      expect(orig).toHaveBeenCalledOnce();
      uninstall();
    });
  });

  describe('attestation redirect safety', () => {
    interface Hop { url: string; method: string; token: string | null; hasBody: boolean }

    /** Drive the patched fetch with a scripted original that records each hop. */
    function scripted(route: (url: string) => Response): { hops: Hop[]; install: (att: ReturnType<typeof fakeAttestor>) => () => void } {
      const hops: Hop[] = [];
      const orig = (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
        hops.push({ url: u, method: init?.method ?? 'GET', token: headers.get('x-aer-attestation'), hasBody: init?.body != null });
        return route(u);
      }) as unknown as typeof fetch;
      return {
        hops,
        install: (att) => { globalThis.fetch = orig; return installFetchPatch(() => {}, att); },
      };
    }

    const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });

    it('re-injects the token on a same-audience (same-host) redirect', async () => {
      const s = scripted((u) => (u.endsWith('/start') ? redirect('https://mcp.internal/next') : new Response('ok', { status: 200 })));
      const att = fakeAttestor({ host: 'mcp.internal', token: 'jwt-1' });
      const uninstall = s.install(att);

      const res = await globalThis.fetch('https://mcp.internal/start');

      expect(res.status).toBe(200);
      expect(s.hops.map((h) => h.token)).toEqual(['jwt-1', 'jwt-1']);
      expect(s.hops[1]?.url).toBe('https://mcp.internal/next');
      uninstall();
    });

    it('STRIPS the token on a cross-origin redirect (no leak)', async () => {
      const s = scripted((u) => (u.endsWith('/start') ? redirect('https://evil.example/grab') : new Response('ok', { status: 200 })));
      const att = fakeAttestor({ host: 'mcp.internal', token: 'jwt-1' });
      const uninstall = s.install(att);

      const res = await globalThis.fetch('https://mcp.internal/start');

      expect(res.status).toBe(200);
      expect(s.hops[0]?.token).toBe('jwt-1');
      expect(s.hops[1]?.url).toBe('https://evil.example/grab');
      expect(s.hops[1]?.token).toBeNull(); // token never reaches another origin
      expect(att.stats.redirect_cross_origin_stripped).toBe(1);
      uninstall();
    });

    it('caps the redirect chain and hands back the last 3xx', async () => {
      const s = scripted(() => redirect('https://mcp.internal/loop'));
      const att = fakeAttestor({ host: 'mcp.internal', token: 'jwt-1' });
      const uninstall = s.install(att);

      const res = await globalThis.fetch('https://mcp.internal/loop');

      expect(res.status).toBe(302);
      expect(s.hops).toHaveLength(21); // MAX_REDIRECTS (20) + the initial request
      uninstall();
    });

    it('respects redirect:"manual" — single injected request, no follow', async () => {
      const s = scripted((u) => (u.endsWith('/start') ? redirect('https://mcp.internal/next') : new Response('ok', { status: 200 })));
      const att = fakeAttestor({ host: 'mcp.internal', token: 'jwt-1' });
      const uninstall = s.install(att);

      const res = await globalThis.fetch('https://mcp.internal/start', { redirect: 'manual' });

      expect(res.status).toBe(302);
      expect(s.hops).toHaveLength(1);
      expect(s.hops[0]?.token).toBe('jwt-1');
      uninstall();
    });

    it('a POST that 303-redirects becomes a bodyless GET, keeping the token same-origin', async () => {
      const s = scripted((u) => (u.endsWith('/start') ? redirect('https://mcp.internal/done', 303) : new Response('ok', { status: 200 })));
      const att = fakeAttestor({ host: 'mcp.internal', token: 'jwt-1' });
      const uninstall = s.install(att);

      const res = await globalThis.fetch('https://mcp.internal/start', { method: 'POST', body: JSON.stringify({ a: 1 }) });

      expect(res.status).toBe(200);
      expect(s.hops[0]).toMatchObject({ method: 'POST', hasBody: true, token: 'jwt-1' });
      expect(s.hops[1]).toMatchObject({ url: 'https://mcp.internal/done', method: 'GET', hasBody: false, token: 'jwt-1' });
      uninstall();
    });
  });
});
