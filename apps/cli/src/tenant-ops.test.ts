import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import {
  listAgents, createAgent,
  listSessions, getSession,
  listFindings, listAudit,
  listAers, getAerMeta,
  getUsage,
} from './tenant-ops.js';

const BASE = 'http://test.local';
const KEY = 'tenant-test-key';

let lastBody: unknown = null;
let lastAuth: string | null = null;

const server = setupServer(
  http.get(`${BASE}/v1/agents`, ({ request }) => {
    lastAuth = request.headers.get('authorization');
    return HttpResponse.json({ agents: [{ agent_id: 'a-1', name: 'demo' }] });
  }),
  http.post(`${BASE}/v1/agents`, async ({ request }) => {
    lastAuth = request.headers.get('authorization');
    lastBody = await request.json();
    return HttpResponse.json({ agent_id: 'a-new' }, { status: 201 });
  }),
  http.get(`${BASE}/v1/sessions`, ({ request }) => {
    const url = new URL(request.url);
    return HttpResponse.json({
      _query: Object.fromEntries(url.searchParams.entries()),
      sessions: [],
      next_cursor: null,
    });
  }),
  http.get(`${BASE}/v1/sessions/:id`, ({ params }) => {
    return HttpResponse.json({ agent_session_id: params.id });
  }),
  http.get(`${BASE}/v1/findings`, ({ request }) => {
    const url = new URL(request.url);
    return HttpResponse.json({
      _query: Object.fromEntries(url.searchParams.entries()),
      findings: [],
    });
  }),
  http.get(`${BASE}/v1/audit`, ({ request }) => {
    const url = new URL(request.url);
    return HttpResponse.json({
      _query: Object.fromEntries(url.searchParams.entries()),
      events: [],
    });
  }),
  http.get(`${BASE}/v1/aers`, ({ request }) => {
    const url = new URL(request.url);
    return HttpResponse.json({
      _query: Object.fromEntries(url.searchParams.entries()),
      aers: [],
      next_cursor: null,
    });
  }),
  http.get(`${BASE}/v1/aers/:id`, ({ params }) => {
    return HttpResponse.json({ aer_id: params.id });
  }),
  http.get(`${BASE}/v1/usage`, ({ request }) => {
    lastAuth = request.headers.get('authorization');
    return HttpResponse.json({
      plan: 'team',
      paid_users: 5,
      period: { start: '2026-10-01T00:00:00.000Z', end: '2026-10-31T23:59:59.999Z' },
      events: { used: 82340, limit: 100000, hard_limit: 125000, percent: 82 },
      sessions: { used: 410, limit: 500, percent: 82 },
      state: 'warning',
      enforcement: 'enforce',
      new_sessions_allowed: true,
      blocked_reason: null,
      upgrade: { available: true, url: 'https://aer.run/settings#usage', pending_request: null },
    });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

describe('CLI tenant-ops', () => {
  it('listAgents passes bearer + parses response', async () => {
    const r = await listAgents({ baseUrl: BASE, apiKey: KEY }) as { agents: unknown[] };
    expect(lastAuth).toBe(`Bearer ${KEY}`);
    expect(r.agents).toHaveLength(1);
  });

  it('createAgent omits framework when not supplied', async () => {
    await createAgent({ baseUrl: BASE, apiKey: KEY, name: 'minimal' });
    expect(lastBody).toEqual({ name: 'minimal' });
  });

  it('createAgent includes framework_type when supplied', async () => {
    await createAgent({ baseUrl: BASE, apiKey: KEY, name: 'lc', frameworkType: 'langchain' });
    expect(lastBody).toEqual({ name: 'lc', framework_type: 'langchain' });
  });

  it('listSessions forwards agent_id + limit query params', async () => {
    const r = await listSessions({ baseUrl: BASE, apiKey: KEY, agentId: 'a-1', limit: 25 }) as { _query: Record<string, string> };
    expect(r._query.agent_id).toBe('a-1');
    expect(r._query.limit).toBe('25');
  });

  it('listSessions omits empty query when no filters', async () => {
    const r = await listSessions({ baseUrl: BASE, apiKey: KEY }) as { _query: Record<string, string> };
    expect(r._query).toEqual({});
  });

  it('getSession hits the correct path', async () => {
    const r = await getSession({ baseUrl: BASE, apiKey: KEY, sessionId: 'sess-xyz' }) as { agent_session_id: string };
    expect(r.agent_session_id).toBe('sess-xyz');
  });

  it('listFindings forwards severity', async () => {
    const r = await listFindings({ baseUrl: BASE, apiKey: KEY, severity: 'high', limit: 5 }) as { _query: Record<string, string> };
    expect(r._query.severity).toBe('high');
    expect(r._query.limit).toBe('5');
  });

  it('listAudit forwards limit', async () => {
    const r = await listAudit({ baseUrl: BASE, apiKey: KEY, limit: 100 }) as { _query: Record<string, string> };
    expect(r._query.limit).toBe('100');
  });

  it('listAers forwards limit + cursor', async () => {
    const r = await listAers({ baseUrl: BASE, apiKey: KEY, limit: 10, cursor: 'abc|def' }) as { _query: Record<string, string> };
    expect(r._query.limit).toBe('10');
    expect(r._query.cursor).toBe('abc|def');
  });

  it('getAerMeta hits the right path', async () => {
    const r = await getAerMeta({ baseUrl: BASE, apiKey: KEY, aerId: 'aer-zzz' }) as { aer_id: string };
    expect(r.aer_id).toBe('aer-zzz');
  });

  it('getUsage passes bearer + parses response', async () => {
    const r = await getUsage({ baseUrl: BASE, apiKey: KEY }) as { plan: string; events: { used: number } };
    expect(lastAuth).toBe(`Bearer ${KEY}`);
    expect(r.plan).toBe('team');
    expect(r.events.used).toBe(82340);
  });

  it('getUsage throws clear error on non-2xx', async () => {
    server.use(
      http.get(`${BASE}/v1/usage`, () => HttpResponse.json({ error: 'forbidden' }, { status: 403 })),
    );
    await expect(getUsage({ baseUrl: BASE, apiKey: 'wrong' })).rejects.toThrow(/403/);
    server.resetHandlers();
  });

  it('throws clear error on non-2xx', async () => {
    server.use(
      http.get(`${BASE}/v1/agents`, () => HttpResponse.json({ error: 'unauthorized' }, { status: 401 })),
    );
    await expect(listAgents({ baseUrl: BASE, apiKey: 'wrong' })).rejects.toThrow(/401/);
    server.resetHandlers();
  });

  it('encodes a path-traversal-shaped session id as one opaque URL segment', async () => {
    let requestedPath = '';
    server.use(
      http.get(`${BASE}/*`, ({ request }) => {
        requestedPath = new URL(request.url).pathname;
        return HttpResponse.json({ agent_session_id: 'x' });
      }),
    );
    await getSession({ baseUrl: BASE, apiKey: KEY, sessionId: '../../v1/admin/tenants' });
    expect(requestedPath).toBe('/v1/sessions/..%2F..%2Fv1%2Fadmin%2Ftenants');
    server.resetHandlers();
  });

  it('encodes a path-traversal-shaped aer id as one opaque URL segment', async () => {
    let requestedPath = '';
    server.use(
      http.get(`${BASE}/*`, ({ request }) => {
        requestedPath = new URL(request.url).pathname;
        return HttpResponse.json({ aer_id: 'x' });
      }),
    );
    await getAerMeta({ baseUrl: BASE, apiKey: KEY, aerId: '../../v1/admin/tenants' });
    expect(requestedPath).toBe('/v1/aers/..%2F..%2Fv1%2Fadmin%2Ftenants');
    server.resetHandlers();
  });

  // CVE-2026-111497: fetch() decodes a Brotli body lazily on first read, and a
  // hostile or misconfigured base_url picks Content-Encoding regardless of
  // what was requested. Garbage bytes rather than real Brotli, so an
  // unguarded read would fail on JSON.parse with a DIFFERENT message than the
  // CVE refusal, proving the guard (not a parse failure) is what rejected it.
  it('refuses a compressed response without reading its body', async () => {
    server.use(
      http.get(`${BASE}/v1/agents`, () => new HttpResponse(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-encoding': 'br' },
      })),
    );
    await expect(listAgents({ baseUrl: BASE, apiKey: KEY })).rejects.toThrow(/CVE-2026-111497/);
    server.resetHandlers();
  });

  it('refuses a compressed error response without reading its body', async () => {
    server.use(
      http.get(`${BASE}/v1/agents`, () => new HttpResponse(new Uint8Array([1, 2, 3]), {
        status: 500,
        headers: { 'content-encoding': 'br' },
      })),
    );
    await expect(listAgents({ baseUrl: BASE, apiKey: KEY })).rejects.toThrow(/CVE-2026-111497/);
    server.resetHandlers();
  });
});
