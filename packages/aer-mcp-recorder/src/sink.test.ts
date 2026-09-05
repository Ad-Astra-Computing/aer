import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHttpSink, sinkFromEnv, NullSink } from './sink.js';
import { COLLECTOR_VERSION } from './recorder.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('sinkFromEnv', () => {
  it('returns null with no relevant env', () => {
    expect(sinkFromEnv({})).toBeNull();
  });

  it('returns null when API key present but identity missing', () => {
    expect(sinkFromEnv({ AER_API_KEY: 'k' })).toBeNull();
    expect(sinkFromEnv({ AER_API_KEY: 'k', AER_TENANT_ID: 't' })).toBeNull();
  });

  it('returns a sink when API key + tenant + agent are present', () => {
    const sink = sinkFromEnv({ AER_API_KEY: 'k', AER_TENANT_ID: 't', AER_AGENT_ID: 'a' });
    expect(sink).not.toBeNull();
    expect(typeof sink!.emit).toBe('function');
  });

  describe('AER_AGENT_VERSION default', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('defaults to mcp-recorder/<version> when unset, so POST /v1/sessions never 400s on a missing var', async () => {
      const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
          calls.push({ url, body });
          if (url.endsWith('/v1/sessions')) return jsonResponse({ agent_session_id: 's1', ingest_token: 'tok' }, 201);
          return jsonResponse({ accepted: 1, rejected: 0 }, 202);
        }),
      );

      const sink = sinkFromEnv({ AER_API_KEY: 'k', AER_TENANT_ID: 't', AER_AGENT_ID: 'a' });
      sink!.emit('tool.started', {});
      await sink!.close();

      const open = calls.find((c) => c.url.endsWith('/v1/sessions'));
      expect(open?.body['agent_version']).toBe(`mcp-recorder/${COLLECTOR_VERSION}`);
    });

    it('leaves an explicit AER_AGENT_VERSION untouched', async () => {
      const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
          calls.push({ url, body });
          if (url.endsWith('/v1/sessions')) return jsonResponse({ agent_session_id: 's1', ingest_token: 'tok' }, 201);
          return jsonResponse({ accepted: 1, rejected: 0 }, 202);
        }),
      );

      const sink = sinkFromEnv({
        AER_API_KEY: 'k',
        AER_TENANT_ID: 't',
        AER_AGENT_ID: 'a',
        AER_AGENT_VERSION: 'my-agent/2.3.0',
      });
      sink!.emit('tool.started', {});
      await sink!.close();

      const open = calls.find((c) => c.url.endsWith('/v1/sessions'));
      expect(open?.body['agent_version']).toBe('my-agent/2.3.0');
    });
  });
});

describe('NullSink', () => {
  it('emits and closes without side effects', async () => {
    const s = new NullSink();
    expect(() => s.emit('x', {})).not.toThrow();
    await expect(s.close()).resolves.toBeUndefined();
  });
});

describe('createHttpSink', () => {
  it('opens a session on the first emit and posts events, completes on close', async () => {
    const calls: Array<{ url: string; body: unknown; auth: string | null }> = [];
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'] ?? null;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body, auth });
      if (url.endsWith('/v1/sessions')) {
        // Real API contract: POST /v1/sessions returns agent_session_id + ingest_token.
        return jsonResponse({ agent_session_id: 'sess-1', ingest_token: 'ingest-xyz', status: 'running' }, 201);
      }
      return jsonResponse({ accepted: 1, rejected: 0, errors: [] }, 202);
    }) as unknown as typeof fetch;

    const sink = createHttpSink({
      baseUrl: 'https://api.test',
      apiKey: 'key-1',
      tenantId: 't1',
      agentId: 'a1',
      fetch: fakeFetch,
      batchSize: 1,
    });

    sink.emit('tool.started', { tool: 'search' });
    // give the fire-and-forget flush a tick
    await new Promise((r) => setTimeout(r, 0));
    await sink.close();

    const urls = calls.map((c) => c.url);
    expect(urls[0]).toBe('https://api.test/v1/sessions');
    expect(calls[0]!.auth).toBe('Bearer key-1');
    expect(urls).toContain('https://api.test/v1/sessions/sess-1/events');
    const eventsCall = calls.find((c) => c.url.endsWith('/events'))!;
    expect(eventsCall.auth).toBe('Bearer ingest-xyz');
    // The ingest API requires a bare array of events, not an { events: [...] } envelope.
    expect(Array.isArray(eventsCall.body)).toBe(true);
    expect((eventsCall.body as unknown[]).length).toBeGreaterThan(0);
    expect(urls).toContain('https://api.test/v1/sessions/sess-1/complete');
  });

  it('batches multiple events into fewer POSTs', async () => {
    let eventPosts = 0;
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/sessions')) return jsonResponse({ id: 's', ingest_token: 'tok' });
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
    await sink.close(); // single flush at close
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
    // logged at most once
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
});
