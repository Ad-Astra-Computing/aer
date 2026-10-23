import { describe, it, expect } from 'vitest';
import { runLiveChecks } from './doctor-live.js';

// A tiny fetch stub keyed by URL suffix → Response-like.
function stubFetch(routes: Record<string, { status: number; json?: unknown; contentEncoding?: string }>): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    const key = Object.keys(routes).find((k) => u.endsWith(k));
    if (!key) throw new Error(`unexpected url ${u}`);
    const r = routes[key]!;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: new Headers(r.contentEncoding ? { 'content-encoding': r.contentEncoding } : {}),
      json: async () => r.json ?? {},
    } as Response;
  }) as unknown as typeof fetch;
}

const byName = (checks: Array<{ name: string; ok: boolean; detail: string }>, name: string) =>
  checks.find((c) => c.name === name)!;

describe('runLiveChecks', () => {
  it('fails fast with remediation when no base URL is set', async () => {
    const r = await runLiveChecks({});
    expect(r.ok).toBe(false);
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0]).toMatchObject({ name: 'AER_BASE_URL', ok: false });
    expect(r.checks[0]!.detail).toContain('export AER_BASE_URL');
  });

  it('passes reachability + auth when readyz is 200 and the key is accepted', async () => {
    const r = await runLiveChecks({
      baseUrl: 'https://api.test/',
      apiKey: 'k',
      fetchFn: stubFetch({
        '/readyz': { status: 200 },
        '/v1/agents': { status: 200, json: { agents: [] } },
        '/v1/usage': {
          status: 200,
          json: {
            state: 'ok', new_sessions_allowed: true, blocked_reason: null,
            events: { used: 0, limit: 100000, percent: 0 },
            sessions: { used: 0, limit: 500, percent: 0 },
            upgrade: { available: true, url: 'https://aer.run/settings#usage', pending_request: null },
          },
        },
      }),
    });
    expect(r.ok).toBe(true);
    expect(byName(r.checks, 'API reachable (/readyz)').ok).toBe(true);
    expect(byName(r.checks, 'tenant auth').ok).toBe(true);
    expect(byName(r.checks, 'usage cap').ok).toBe(true);
  });

  it('flags a rejected key (401) with remediation and skips nothing else', async () => {
    const r = await runLiveChecks({
      baseUrl: 'https://api.test',
      apiKey: 'bad',
      fetchFn: stubFetch({ '/readyz': { status: 200 }, '/v1/agents': { status: 401 } }),
    });
    expect(r.ok).toBe(false);
    expect(byName(r.checks, 'tenant auth')).toMatchObject({ ok: false });
    expect(byName(r.checks, 'tenant auth').detail).toContain('key rejected');
  });

  it('reports auth missing when no key is provided', async () => {
    const r = await runLiveChecks({
      baseUrl: 'https://api.test',
      fetchFn: stubFetch({ '/readyz': { status: 200 } }),
    });
    expect(byName(r.checks, 'tenant auth')).toMatchObject({ ok: false });
    expect(byName(r.checks, 'tenant auth').detail).toContain('no API key');
  });

  it('turns a network error on /readyz into a failing check, not a throw', async () => {
    const fetchFn = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const r = await runLiveChecks({ baseUrl: 'https://api.test', apiKey: 'k', fetchFn });
    expect(r.ok).toBe(false);
    expect(byName(r.checks, 'API reachable (/readyz)').detail).toContain('unreachable');
    // auth is skipped because the API is unreachable
    expect(byName(r.checks, 'tenant auth').detail).toContain('skipped');
  });

  it('passes the usage cap check when the API allows new sessions', async () => {
    const r = await runLiveChecks({
      baseUrl: 'https://api.test',
      apiKey: 'k',
      fetchFn: stubFetch({
        '/readyz': { status: 200 },
        '/v1/agents': { status: 200, json: { agents: [] } },
        '/v1/usage': {
          status: 200,
          json: {
            state: 'warning',
            new_sessions_allowed: true,
            blocked_reason: null,
            events: { used: 82340, limit: 100000, percent: 82 },
            sessions: { used: 410, limit: 500, percent: 82 },
            upgrade: { available: true, url: 'https://aer.run/settings#usage', pending_request: null },
          },
        },
      }),
    });
    expect(r.ok).toBe(true);
    const check = byName(r.checks, 'usage cap');
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('warning');
    expect(check.detail).toContain('82%');
  });

  it('fails the usage cap check when the API refuses new sessions', async () => {
    const r = await runLiveChecks({
      baseUrl: 'https://api.test',
      apiKey: 'k',
      fetchFn: stubFetch({
        '/readyz': { status: 200 },
        '/v1/agents': { status: 200, json: { agents: [] } },
        '/v1/usage': {
          status: 200,
          json: {
            state: 'hard_limit',
            new_sessions_allowed: false,
            blocked_reason: 'events',
            events: { used: 125000, limit: 100000, hard_limit: 125000, percent: 125 },
            sessions: { used: 410, limit: 500, percent: 82 },
            upgrade: { available: true, url: 'https://aer.run/settings#usage', pending_request: null },
          },
        },
      }),
    });
    expect(r.ok).toBe(false);
    const check = byName(r.checks, 'usage cap');
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('events');
    expect(check.detail).toContain('125000');
    expect(check.detail).toContain('https://aer.run/settings#usage');
  });

  it('skips the usage cap check when there is no API key', async () => {
    const r = await runLiveChecks({
      baseUrl: 'https://api.test',
      fetchFn: stubFetch({ '/readyz': { status: 200 } }),
    });
    const check = byName(r.checks, 'usage cap');
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('no API key');
  });

  it('skips the usage cap check when the API is not reachable', async () => {
    const r = await runLiveChecks({
      baseUrl: 'https://api.test',
      apiKey: 'k',
      fetchFn: stubFetch({ '/readyz': { status: 503 } }),
    });
    const check = byName(r.checks, 'usage cap');
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('skipped');
  });

  it('fails the usage cap check on a network error', async () => {
    const fetchFn = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/readyz')) return { ok: true, status: 200, json: async () => ({}) } as Response;
      if (u.endsWith('/v1/agents')) return { ok: true, status: 200, json: async () => ({ agents: [] }) } as Response;
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const r = await runLiveChecks({ baseUrl: 'https://api.test', apiKey: 'k', fetchFn });
    const check = byName(r.checks, 'usage cap');
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('request failed');
  });

  it('fails the usage cap check on a non-200 status', async () => {
    const r = await runLiveChecks({
      baseUrl: 'https://api.test',
      apiKey: 'k',
      fetchFn: stubFetch({
        '/readyz': { status: 200 },
        '/v1/agents': { status: 200, json: { agents: [] } },
        '/v1/usage': { status: 500 },
      }),
    });
    const check = byName(r.checks, 'usage cap');
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('500');
  });

  it('validates agent_id against the tenant agent list when provided', async () => {
    const ok = await runLiveChecks({
      baseUrl: 'https://api.test', apiKey: 'k', agentId: 'a-1',
      fetchFn: stubFetch({ '/readyz': { status: 200 }, '/v1/agents': { status: 200, json: { agents: [{ agent_id: 'a-1' }] } } }),
    });
    expect(byName(ok.checks, 'agent_id')).toMatchObject({ ok: true });

    const missing = await runLiveChecks({
      baseUrl: 'https://api.test', apiKey: 'k', agentId: 'a-9',
      fetchFn: stubFetch({ '/readyz': { status: 200 }, '/v1/agents': { status: 200, json: { agents: [{ agent_id: 'a-1' }] } } }),
    });
    expect(byName(missing.checks, 'agent_id')).toMatchObject({ ok: false });
    expect(byName(missing.checks, 'agent_id').detail).toContain('not found');
  });

  it('fails agent_id when the agent is paused, even though it was found', async () => {
    const r = await runLiveChecks({
      baseUrl: 'https://api.test', apiKey: 'k', agentId: 'a-1',
      fetchFn: stubFetch({
        '/readyz': { status: 200 },
        '/v1/agents': { status: 200, json: { agents: [{ agent_id: 'a-1', status: 'paused' }] } },
      }),
    });
    expect(byName(r.checks, 'agent_id')).toMatchObject({ ok: false });
    expect(byName(r.checks, 'agent_id').detail).toContain('paused');
  });

  it('skips the usage cap check, rather than reporting a duplicate failure, when the key is already rejected', async () => {
    const fetchFn = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/readyz')) return { ok: true, status: 200, json: async () => ({}) } as Response;
      if (u.endsWith('/v1/agents')) return { ok: false, status: 401, json: async () => ({}) } as Response;
      throw new Error(`unexpected url ${u}`); // /v1/usage must never be called here
    }) as unknown as typeof fetch;
    const r = await runLiveChecks({ baseUrl: 'https://api.test', apiKey: 'bad', fetchFn });
    const check = byName(r.checks, 'usage cap');
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('skipped');
    expect(check.detail).not.toContain('unexpected HTTP');
  });

  it('reports an unrecognised response rather than a fabricated cap block on a malformed 200', async () => {
    const r = await runLiveChecks({
      baseUrl: 'https://api.test',
      apiKey: 'k',
      fetchFn: stubFetch({
        '/readyz': { status: 200 },
        '/v1/agents': { status: 200, json: { agents: [] } },
        '/v1/usage': { status: 200, json: { ok: true } }, // no new_sessions_allowed at all
      }),
    });
    const check = byName(r.checks, 'usage cap');
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('unrecognised response');
    expect(check.detail).not.toContain('blocked on');
  });

  // CVE-2026-111497: fetch() decodes a Brotli body lazily on first read, and a
  // hostile or misconfigured base_url picks Content-Encoding regardless of
  // what was requested. The /readyz and tenant-auth checks never read a body
  // (only .ok/.status) so they are not exposed; agent_id is the one check
  // here that does, via res.json().
  it('turns a compressed agent_id response into a failing check, not a throw', async () => {
    const r = await runLiveChecks({
      baseUrl: 'https://api.test', apiKey: 'k', agentId: 'a-1',
      fetchFn: stubFetch({
        '/readyz': { status: 200 },
        '/v1/agents': { status: 200, contentEncoding: 'br' },
      }),
    });
    expect(byName(r.checks, 'agent_id')).toMatchObject({ ok: false });
    expect(byName(r.checks, 'agent_id').detail).toMatch(/CVE-2026-111497/);
  });
});
