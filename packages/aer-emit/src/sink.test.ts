import { describe, it, expect, vi } from 'vitest';
import { createHttpSink, NullSink } from './sink.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('NullSink', () => {
  it('emits and closes without side effects', async () => {
    const s = new NullSink();
    expect(() => s.emit('x', {})).not.toThrow();
    await expect(s.close()).resolves.toBeUndefined();
  });
});

describe('createHttpSink', () => {
  it('opens a session on the first emit, posts events, completes on close', async () => {
    const calls: Array<{ url: string; body: unknown; auth: string | null }> = [];
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'] ?? null;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body, auth });
      // Real API contract: POST /v1/sessions returns agent_session_id + ingest_token.
      if (url.endsWith('/v1/sessions')) return jsonResponse({ agent_session_id: 'sess-1', ingest_token: 'ingest-xyz', status: 'running' }, 201);
      return jsonResponse({ accepted: 1, rejected: 0, errors: [] }, 202);
    }) as unknown as typeof fetch;

    const sink = createHttpSink({
      baseUrl: 'https://api.test',
      apiKey: 'key-1',
      tenantId: 't1',
      agentId: 'a1',
      environmentId: 'e1',
      agentVersion: 'v9',
      principal: { id: 'p1', kind: 'user' },
      fetch: fakeFetch,
      batchSize: 1,
    });

    sink.emit('tool.started', { tool: 'search' });
    await new Promise((r) => setTimeout(r, 0));
    await sink.close();

    const urls = calls.map((c) => c.url);
    expect(urls[0]).toBe('https://api.test/v1/sessions');
    expect(calls[0]!.auth).toBe('Bearer key-1');
    // identity forwarded in the open body
    const open = calls[0]!.body as Record<string, unknown>;
    expect(open['tenant_id']).toBe('t1');
    expect(open['agent_id']).toBe('a1');
    expect(open['environment_id']).toBe('e1');
    expect(open['agent_version']).toBe('v9');
    expect(open['principal']).toEqual({ id: 'p1', kind: 'user' });

    expect(urls).toContain('https://api.test/v1/sessions/sess-1/events');
    const eventsCall = calls.find((c) => c.url.endsWith('/events'))!;
    expect(eventsCall.auth).toBe('Bearer ingest-xyz');
    // The API requires a BARE ARRAY (events.ts: `if (!Array.isArray(body)) 400`),
    // not an { events: [...] } envelope.
    expect(Array.isArray(eventsCall.body)).toBe(true);
    expect((eventsCall.body as unknown[]).length).toBeGreaterThan(0);
    expect(urls).toContain('https://api.test/v1/sessions/sess-1/complete');
  });

  it('emits events whose wire shape satisfies the API EventSchema', async () => {
    let eventsBody: unknown;
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/sessions')) return jsonResponse({ agent_session_id: 'sess-1', ingest_token: 'tok', status: 'running' }, 201);
      if (url.endsWith('/events')) eventsBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      return jsonResponse({ accepted: 1, rejected: 0, errors: [] }, 202);
    }) as unknown as typeof fetch;

    const sink = createHttpSink({
      baseUrl: 'https://api.test', apiKey: 'k', tenantId: 't', agentId: 'a',
      fetch: fakeFetch, batchSize: 1,
      newId: () => '11111111-1111-4111-8111-111111111111',
      now: () => new Date('2026-07-19T00:00:00.000Z'),
      sourceType: 'wrapper',
    });
    sink.emit('tool.started', { tool: 'search' });
    await new Promise((r) => setTimeout(r, 0));
    await sink.close();

    const arr = eventsBody as Array<Record<string, unknown>>;
    expect(Array.isArray(arr)).toBe(true);
    const ev = arr[0]!;
    // BaseEvent + variant fields the API's .strict() schema requires...
    expect(ev['event_id']).toBe('11111111-1111-4111-8111-111111111111');
    expect(ev['agent_session_id']).toBe('sess-1');
    expect(ev['event_type']).toBe('tool.started');
    expect(ev['source_type']).toBe('wrapper');
    expect(ev['severity_hint']).toBe('info');
    expect(ev['timestamp_observed']).toBe('2026-07-19T00:00:00.000Z');
    expect(ev['payload']).toEqual({ tool: 'search' });
    // ...and NONE of the old stray keys that .strict() would reject.
    expect(ev).not.toHaveProperty('seq');
    expect(ev).not.toHaveProperty('type');
    expect(ev).not.toHaveProperty('ts');
  });

  it('batches multiple events into a single POST', async () => {
    let eventPosts = 0;
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/sessions')) return jsonResponse({ agent_session_id: 's', ingest_token: 'tok', status: 'running' }, 201);
      if (url.endsWith('/events')) eventPosts++;
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const sink = createHttpSink({
      baseUrl: 'https://api.test',
      apiKey: 'k',
      tenantId: 't',
      agentId: 'a',
      fetch: fakeFetch,
      batchSize: 100,
    });
    for (let i = 0; i < 5; i++) sink.emit('tool.started', { i });
    await sink.close();
    expect(eventPosts).toBe(1);
  });

  it('swallows a failing session open: emit and close never reject', async () => {
    const fakeFetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const errors: string[] = [];
    const sink = createHttpSink({
      baseUrl: 'https://api.test',
      apiKey: 'k',
      tenantId: 't',
      agentId: 'a',
      fetch: fakeFetch,
      batchSize: 1,
      logError: (m) => errors.push(m),
    });
    expect(() => sink.emit('tool.started', {})).not.toThrow();
    await expect(sink.close()).resolves.toBeUndefined();
    expect(errors.length).toBeLessThanOrEqual(1);
  });

  it('swallows a non-2xx session open', async () => {
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/sessions')) return jsonResponse({ error: 'nope' }, 403);
      return jsonResponse({});
    }) as unknown as typeof fetch;
    const sink = createHttpSink({
      baseUrl: 'https://api.test',
      apiKey: 'k',
      tenantId: 't',
      agentId: 'a',
      fetch: fakeFetch,
      batchSize: 1,
    });
    sink.emit('tool.started', {});
    await expect(sink.close()).resolves.toBeUndefined();
  });

  it('does not touch the network when no events are ever emitted', async () => {
    const fakeFetch = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    const sink = createHttpSink({
      baseUrl: 'https://api.test',
      apiKey: 'k',
      tenantId: 't',
      agentId: 'a',
      fetch: fakeFetch,
    });
    await sink.close();
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('uses a custom log label in diagnostics', async () => {
    const fakeFetch = vi.fn(async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    const errors: string[] = [];
    const sink = createHttpSink({
      baseUrl: 'https://api.test',
      apiKey: 'k',
      tenantId: 't',
      agentId: 'a',
      fetch: fakeFetch,
      batchSize: 1,
      logLabel: 'aer-hook',
      logError: (m) => errors.push(m),
    });
    sink.emit('tool.started', {});
    await sink.close();
    expect(errors[0] ?? '').toContain('aer-hook');
  });

  it('attach mode: never opens a session, emits to the given id, does not complete', async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), auth: (init?.headers as Record<string, string>)?.['authorization'] ?? null });
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const sink = createHttpSink({
      baseUrl: 'https://api.test', apiKey: 'key-1', fetch: fakeFetch, batchSize: 1,
      session: { id: 'existing-sess', ingestToken: 'ingest-abc' },
      completeOnClose: false,
    });
    sink.emit('tool.started', { tool: 'x' });
    await new Promise((r) => setTimeout(r, 0));
    await sink.close();

    // No POST /v1/sessions (open) and no /complete.
    expect(calls.some((c) => c.url.endsWith('/v1/sessions'))).toBe(false);
    expect(calls.some((c) => c.url.endsWith('/complete'))).toBe(false);
    // Events went to the attached session with its ingest token.
    const ev = calls.find((c) => c.url.endsWith('/existing-sess/events'));
    expect(ev?.auth).toBe('Bearer ingest-abc');
  });

  it('onOpen fires once with the opened session identity', async () => {
    const opened: Array<{ id: string; ingestToken: string }> = [];
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/v1/sessions')) return jsonResponse({ agent_session_id: 'sess-9', ingest_token: 'tok-9', status: 'running' }, 201);
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const sink = createHttpSink({
      baseUrl: 'https://api.test', apiKey: 'k', fetch: fakeFetch, batchSize: 1,
      onOpen: (info) => opened.push(info),
    });
    sink.emit('tool.started', {});
    await new Promise((r) => setTimeout(r, 0));
    await sink.close();
    expect(opened).toEqual([{ id: 'sess-9', ingestToken: 'tok-9' }]);
  });

  it('completeOnClose:false on an opened session skips /complete', async () => {
    const calls: string[] = [];
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (String(input).endsWith('/v1/sessions')) return jsonResponse({ agent_session_id: 's', ingest_token: 't', status: 'running' }, 201);
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;
    const sink = createHttpSink({ baseUrl: 'https://api.test', apiKey: 'k', fetch: fakeFetch, batchSize: 1, completeOnClose: false });
    sink.emit('e', {});
    await new Promise((r) => setTimeout(r, 0));
    await sink.close();
    expect(calls.some((u) => u.endsWith('/complete'))).toBe(false);
  });
});
