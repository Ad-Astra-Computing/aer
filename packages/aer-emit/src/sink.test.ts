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

describe('createHttpSink: close()/flush() race', () => {
  it('awaits an in-flight batch-triggered flush before posting /complete', async () => {
    const order: string[] = [];
    let releaseEventsPost: (() => void) | undefined;
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/sessions')) return jsonResponse({ agent_session_id: 's1', ingest_token: 't1', status: 'running' }, 201);
      if (url.endsWith('/events')) {
        await new Promise<void>((resolve) => {
          releaseEventsPost = resolve;
        });
        order.push('events');
        return jsonResponse({ accepted: 2, rejected: 0, errors: [] }, 202);
      }
      if (url.endsWith('/complete')) {
        order.push('complete');
        return jsonResponse({ aer_id: 'a', canonical_hash: 'h', signing_key_id: 'k', findings_count: 0 }, 200);
      }
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const sink = createHttpSink({
      baseUrl: 'https://api.test',
      apiKey: 'k',
      tenantId: 't',
      agentId: 'a',
      fetch: fakeFetch,
      batchSize: 2,
    });

    sink.emit('tool.started', { i: 1 });
    sink.emit('tool.completed', { i: 2 }); // crosses batchSize=2: fire-and-forget flush starts
    // let the session open and the /events request start (and block on releaseEventsPost)
    await new Promise((r) => setTimeout(r, 0));

    const closePromise = sink.close();
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]); // /complete must not have fired while /events is still in flight
    releaseEventsPost?.();
    await closePromise;

    expect(order).toEqual(['events', 'complete']);
  });
});

describe('createHttpSink: batch chunking', () => {
  it('splits a large synchronous burst into POSTs of at most 500 events', async () => {
    const postedSizes: number[] = [];
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/sessions')) return jsonResponse({ agent_session_id: 's1', ingest_token: 't1', status: 'running' }, 201);
      if (url.endsWith('/events')) {
        const body = JSON.parse(String(init?.body)) as unknown[];
        postedSizes.push(body.length);
        return jsonResponse({ accepted: body.length, rejected: 0, errors: [] }, 202);
      }
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const sink = createHttpSink({
      baseUrl: 'https://api.test',
      apiKey: 'k',
      tenantId: 't',
      agentId: 'a',
      fetch: fakeFetch,
      batchSize: 64,
    });

    for (let i = 0; i < 1500; i++) sink.emit('tool.started', { i });
    await sink.close();

    expect(postedSizes.length).toBe(3);
    for (const size of postedSizes) expect(size).toBeLessThanOrEqual(500);
    expect(postedSizes.reduce((a, b) => a + b, 0)).toBe(1500);
  });
});

describe('createHttpSink: partial-accept diagnostics', () => {
  it('logs once when the server reports rejected > 0 on a 207, and keeps the sink enabled', async () => {
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/sessions')) return jsonResponse({ agent_session_id: 's1', ingest_token: 't1', status: 'running' }, 201);
      if (url.endsWith('/events')) {
        return jsonResponse(
          { accepted: 1, rejected: 1, errors: [{ index: 1, issues: [{ path: ['payload'], message: 'payload_value_out_of_bounds' }] }] },
          207,
        );
      }
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const errors: string[] = [];
    const sink = createHttpSink({
      baseUrl: 'https://api.test',
      apiKey: 'k',
      tenantId: 't',
      agentId: 'a',
      fetch: fakeFetch,
      batchSize: 2,
      logError: (m) => errors.push(m),
    });

    sink.emit('tool.started', { tool: 'ok' });
    sink.emit('tool.completed', { tool: 'bad' });
    await sink.close();

    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some((m) => m.includes('rejected'))).toBe(true);

    // The sink must still be usable afterward - it is not disabled by a partial accept.
    sink.emit('tool.started', { tool: 'next' });
    expect(() => sink.emit('tool.started', { tool: 'next2' })).not.toThrow();
  });

  it('logs once on a 202 that reports dropped_keys / warning (bodies-off enforcement)', async () => {
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/sessions')) return jsonResponse({ agent_session_id: 's1', ingest_token: 't1', status: 'running' }, 201);
      if (url.endsWith('/events')) {
        return jsonResponse({ accepted: 1, rejected: 0, errors: [], events_sanitized: 1, dropped_keys: ['payload.foo'], warning: 'payload_keys_dropped' }, 202);
      }
      return jsonResponse({});
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
    sink.emit('tool.started', { foo: 'x' });
    await sink.close();
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});

describe('createHttpSink: bounded retry', () => {
  it('retries a 429 honoring Retry-After (capped at 5s) then succeeds without disabling', async () => {
    vi.useFakeTimers();
    try {
      let eventAttempts = 0;
      const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/v1/sessions')) return jsonResponse({ agent_session_id: 's1', ingest_token: 't1', status: 'running' }, 201);
        if (url.endsWith('/events')) {
          eventAttempts++;
          if (eventAttempts === 1) {
            return new Response(JSON.stringify({ error: 'rate_limited' }), {
              status: 429,
              headers: { 'content-type': 'application/json', 'retry-after': '100' },
            });
          }
          return jsonResponse({ accepted: 1, rejected: 0, errors: [] }, 202);
        }
        return jsonResponse({});
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

      sink.emit('tool.started', {});
      await vi.advanceTimersByTimeAsync(0);
      expect(eventAttempts).toBe(1);
      // A real 100s Retry-After must be capped at 5s, not honored in full.
      await vi.advanceTimersByTimeAsync(5000);
      expect(eventAttempts).toBe(2);
      await sink.close();
      expect(errors.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries 502/503/504 up to 3 times, then drops the batch and logs once without disabling', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/v1/sessions')) return jsonResponse({ agent_session_id: 's1', ingest_token: 't1', status: 'running' }, 201);
        if (url.endsWith('/events')) {
          attempts++;
          return new Response('bad gateway', { status: 503 });
        }
        return jsonResponse({});
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

      sink.emit('tool.started', {});
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(60000);

      expect(attempts).toBe(4); // 1 initial + 3 retries
      expect(errors.length).toBe(1);

      // The sink is not permanently disabled by a transient failure: it can still emit.
      sink.emit('tool.started', { second: true });
      await vi.advanceTimersByTimeAsync(60000);
      await sink.close();
      expect(attempts).toBeGreaterThan(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry and disables the sink on a 401', async () => {
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/sessions')) return jsonResponse({ agent_session_id: 's1', ingest_token: 't1', status: 'running' }, 201);
      if (url.endsWith('/events')) return jsonResponse({ error: 'unauthorized' }, 401);
      return jsonResponse({});
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
    sink.emit('tool.started', {});
    await sink.close();
    expect(fakeFetch.mock.calls.filter((c) => String(c[0]).endsWith('/events')).length).toBe(1);
    expect(errors.length).toBe(1);
  });
});

describe('createHttpSink: bounded buffer', () => {
  it('caps pending events and drops the oldest once over the limit, with a single diagnostic', async () => {
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/sessions')) return jsonResponse({ agent_session_id: 's1', ingest_token: 't1', status: 'running' }, 201);
      if (url.endsWith('/events')) {
        const body = JSON.parse(String(init?.body)) as Array<{ payload: { i: number } }>;
        return jsonResponse({ accepted: body.length, rejected: 0, errors: [] }, 202);
      }
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const errors: string[] = [];
    // batchSize larger than the burst so nothing auto-flushes mid-burst.
    const sink = createHttpSink({
      baseUrl: 'https://api.test',
      apiKey: 'k',
      tenantId: 't',
      agentId: 'a',
      fetch: fakeFetch,
      batchSize: 20000,
      maxPending: 10000,
      logError: (m) => errors.push(m),
    });

    for (let i = 0; i < 10005; i++) sink.emit('tool.started', { i });
    await sink.close();

    const totalPosted = fakeFetch.mock.calls
      .filter((c) => String(c[0]).endsWith('/events'))
      .reduce((sum, c) => sum + (JSON.parse(String((c[1] as RequestInit).body)) as unknown[]).length, 0);
    expect(totalPosted).toBe(10000);
    expect(errors.some((m) => m.toLowerCase().includes('drop'))).toBe(true);
  });
});

describe('createHttpSink: exit flush', () => {
  it('registers exactly one beforeExit handler that best-effort flushes pending events', async () => {
    const onSpy = vi.spyOn(process, 'on');
    const removeSpy = vi.spyOn(process, 'removeListener');
    try {
      const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/v1/sessions')) return jsonResponse({ agent_session_id: 's1', ingest_token: 't1', status: 'running' }, 201);
        return jsonResponse({ accepted: 1, rejected: 0, errors: [] }, 202);
      }) as unknown as typeof fetch;

      const sink = createHttpSink({
        baseUrl: 'https://api.test',
        apiKey: 'k',
        tenantId: 't',
        agentId: 'a',
        fetch: fakeFetch,
        batchSize: 100,
      });

      const beforeExitRegistrations = onSpy.mock.calls.filter((c) => c[0] === 'beforeExit');
      expect(beforeExitRegistrations.length).toBe(1);
      const handler = beforeExitRegistrations[0]![1] as () => void;

      sink.emit('tool.started', {});
      handler(); // simulate the event loop going idle
      await new Promise((r) => setTimeout(r, 0));
      expect(fakeFetch.mock.calls.some((c) => String(c[0]).endsWith('/events'))).toBe(true);

      await sink.close();
      expect(removeSpy.mock.calls.some((c) => c[0] === 'beforeExit')).toBe(true);
    } finally {
      onSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });
});

describe('createHttpSink: request timeout', () => {
  it('aborts a hanging request after requestTimeoutMs and treats it as a network error', async () => {
    vi.useFakeTimers();
    try {
      let sawAbort = false;
      const fakeFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/v1/sessions')) return Promise.resolve(jsonResponse({ agent_session_id: 's1', ingest_token: 't1', status: 'running' }, 201));
        if (url.endsWith('/events')) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              sawAbort = true;
              reject(new DOMException('The operation was aborted', 'AbortError'));
            });
          });
        }
        return Promise.resolve(jsonResponse({}));
      }) as unknown as typeof fetch;

      const errors: string[] = [];
      const sink = createHttpSink({
        baseUrl: 'https://api.test',
        apiKey: 'k',
        tenantId: 't',
        agentId: 'a',
        fetch: fakeFetch,
        batchSize: 1,
        requestTimeoutMs: 50,
        logError: (m) => errors.push(m),
      });

      sink.emit('tool.started', {});
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(60000);

      expect(sawAbort).toBe(true);
      await sink.close();
      expect(errors.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
