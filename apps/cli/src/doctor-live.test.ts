import { describe, it, expect } from 'vitest';
import { runLiveChecks } from './doctor-live.js';

// A tiny fetch stub keyed by URL suffix → Response-like.
function stubFetch(routes: Record<string, { status: number; json?: unknown }>): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    const key = Object.keys(routes).find((k) => u.endsWith(k));
    if (!key) throw new Error(`unexpected url ${u}`);
    const r = routes[key]!;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
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
      fetchFn: stubFetch({ '/readyz': { status: 200 }, '/v1/agents': { status: 200, json: { agents: [] } } }),
    });
    expect(r.ok).toBe(true);
    expect(byName(r.checks, 'API reachable (/readyz)').ok).toBe(true);
    expect(byName(r.checks, 'tenant auth').ok).toBe(true);
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
});
