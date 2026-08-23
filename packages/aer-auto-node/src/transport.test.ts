import { describe, it, expect } from 'vitest';
import { createHttpTransport } from './transport.js';

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }

function fakeFetch(handlers: Array<(c: Call) => Response>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    const h = handlers[Math.min(i, handlers.length - 1)];
    i += 1;
    return h!(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const ok202 = () => new Response(JSON.stringify({ accepted: 1, rejected: 0, errors: [] }), { status: 202 });
const opened = () =>
  new Response(JSON.stringify({ agent_session_id: 'sess-1', ingest_token: 'tok-1', status: 'running' }), { status: 201 });

function makeTransport(fetchImpl: typeof fetch) {
  let n = 0;
  return createHttpTransport({
    baseUrl: 'https://aer-api.test/',
    apiKey: 'api-key-123',
    tenantId: 't-1',
    agentId: 'a-1',
    envId: 'e-1',
    agentVersion: '9.9.9',
    fetchImpl,
    clock: () => new Date('2026-06-17T00:00:00.000Z'),
    newId: () => `id-${++n}`,
  });
}

describe('createHttpTransport', () => {
  it('open() POSTs /v1/sessions with the API key and create-session body', async () => {
    const { fetchImpl, calls } = fakeFetch([opened]);
    await makeTransport(fetchImpl).open();
    expect(calls[0]?.url).toBe('https://aer-api.test/v1/sessions');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers['authorization']).toBe('Bearer api-key-123');
    expect(calls[0]?.body).toEqual({
      tenant_id: 't-1', agent_id: 'a-1', agent_version: '9.9.9', environment_id: 'e-1',
    });
  });

  it('open() includes principal in the body only when configured', async () => {
    const { fetchImpl, calls } = fakeFetch([opened]);
    const t = createHttpTransport({
      baseUrl: 'https://aer-api.test/', apiKey: 'k', tenantId: 't-1', agentId: 'a-1',
      envId: 'e-1', agentVersion: '9.9.9', fetchImpl,
      principal: { id: 'emp-77', kind: 'user', display: 'Grace H.' },
    });
    await t.open();
    expect(calls[0]?.body).toEqual({
      tenant_id: 't-1', agent_id: 'a-1', agent_version: '9.9.9', environment_id: 'e-1',
      principal: { id: 'emp-77', kind: 'user', display: 'Grace H.' },
    });
  });

  it('open() omits the principal key entirely when none is set (byte-identical body)', async () => {
    const { fetchImpl, calls } = fakeFetch([opened]);
    await makeTransport(fetchImpl).open();
    expect(calls[0]?.body).not.toHaveProperty('principal');
  });

  it('open() includes the collector declaration in the body only when configured', async () => {
    const { fetchImpl, calls } = fakeFetch([opened]);
    const t = createHttpTransport({
      baseUrl: 'https://aer-api.test/', apiKey: 'k', tenantId: 't-1', agentId: 'a-1',
      envId: 'e-1', agentVersion: '9.9.9', fetchImpl,
      collector: { name: '@adastracomputing/aer-auto-node', version: '0.2.0', schema_capability: 'aer-events.v1' },
    });
    await t.open();
    expect(calls[0]?.body).toEqual({
      tenant_id: 't-1', agent_id: 'a-1', agent_version: '9.9.9', environment_id: 'e-1',
      collector: { name: '@adastracomputing/aer-auto-node', version: '0.2.0', schema_capability: 'aer-events.v1' },
    });
  });

  it('open() omits the collector key entirely when unset (byte-identical body)', async () => {
    const { fetchImpl, calls } = fakeFetch([opened]);
    await makeTransport(fetchImpl).open();
    expect(calls[0]?.body).not.toHaveProperty('collector');
  });

  it('emit() stamps source_type=wrapper, ids, and timestamps, using the ingest token', async () => {
    const { fetchImpl, calls } = fakeFetch([opened, ok202]);
    const t = makeTransport(fetchImpl);
    await t.open();
    await t.emit([
      { event_type: 'http.requested', payload: { host: 'api.openai.com', method: 'POST' } },
      { event_type: 'process.exec', payload: { command: 'git' }, severity_hint: 'low' },
    ]);

    const emitCall = calls[1]!;
    expect(emitCall.url).toBe('https://aer-api.test/v1/sessions/sess-1/events');
    expect(emitCall.headers['authorization']).toBe('Bearer tok-1');
    const body = emitCall.body as Array<Record<string, unknown>>;
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({
      event_id: 'id-1',
      agent_session_id: 'sess-1',
      event_type: 'http.requested',
      source_type: 'wrapper',
      severity_hint: 'info',
      timestamp_observed: '2026-06-17T00:00:00.000Z',
      payload: { host: 'api.openai.com', method: 'POST' },
    });
    expect(body[1]).toMatchObject({ event_type: 'process.exec', severity_hint: 'low', source_type: 'wrapper' });
  });

  it('complete() POSTs /complete with the ingest token', async () => {
    const { fetchImpl, calls } = fakeFetch([
      opened,
      () => new Response(JSON.stringify({ aer_id: 'aer-1', canonical_hash: 'h', signing_key_id: 'k', findings_count: 0 }), { status: 200 }),
    ]);
    const t = makeTransport(fetchImpl);
    await t.open();
    await t.complete();
    expect(calls[1]?.url).toBe('https://aer-api.test/v1/sessions/sess-1/complete');
    expect(calls[1]?.headers['authorization']).toBe('Bearer tok-1');
  });

  it('abort() tolerates a 409 (already terminated)', async () => {
    const { fetchImpl } = fakeFetch([opened, () => new Response('not_running', { status: 409 })]);
    const t = makeTransport(fetchImpl);
    await t.open();
    await expect(t.abort()).resolves.toBeUndefined();
  });

  it('mintAttestation() POSTs the audience with the ingest token and parses expiry', async () => {
    const opened2 = () => new Response(JSON.stringify({ agent_session_id: 'sess-1', ingest_token: 'tok-1', status: 'running' }), { status: 201 });
    const mintRes = () => new Response(JSON.stringify({ token: 'jwt-abc', token_type: 'Bearer', expires_at: '2026-06-20T00:05:00.000Z', audience: 'mcp://x' }), { status: 200 });
    const { fetchImpl, calls } = fakeFetch([opened2, mintRes]);
    const t = makeTransport(fetchImpl);
    await t.open();
    const r = await t.mintAttestation!('mcp://x');
    expect(calls[1]?.url).toBe('https://aer-api.test/v1/sessions/sess-1/attestations');
    expect(calls[1]?.headers['authorization']).toBe('Bearer tok-1');
    expect(calls[1]?.body).toEqual({ audience: 'mcp://x' });
    expect(r.token).toBe('jwt-abc');
    expect(r.expiresAtMs).toBe(Date.parse('2026-06-20T00:05:00.000Z'));
  });

  it('mintAttestation() includes requested scopes in the body when present', async () => {
    const opened2 = () => new Response(JSON.stringify({ agent_session_id: 'sess-1', ingest_token: 'tok-1', status: 'running' }), { status: 201 });
    const mintRes = () => new Response(JSON.stringify({ token: 'jwt-abc', token_type: 'Bearer', expires_at: '2026-06-20T00:05:00.000Z', audience: 'mcp://x', scopes: ['tools.read'] }), { status: 200 });
    const { fetchImpl, calls } = fakeFetch([opened2, mintRes]);
    const t = makeTransport(fetchImpl);
    await t.open();
    await t.mintAttestation!('mcp://x', ['tools.read']);
    expect(calls[1]?.body).toEqual({ audience: 'mcp://x', scopes: ['tools.read'] });
  });

  it('emit() before open throws (guards against misuse)', async () => {
    const { fetchImpl } = fakeFetch([ok202]);
    const t = makeTransport(fetchImpl);
    await expect(t.emit([{ event_type: 'http.requested', payload: {} }])).rejects.toThrow();
  });

  it('open() throws on a non-2xx create-session response', async () => {
    const { fetchImpl } = fakeFetch([() => new Response('nope', { status: 401 })]);
    await expect(makeTransport(fetchImpl).open()).rejects.toThrow();
  });
});
