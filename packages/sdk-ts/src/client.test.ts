import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { createAerClient, type AerClient } from './client.js';
import { newUuidV7 } from './uuid.js';

type ReceivedBatch = Array<Record<string, unknown>>;

let receivedBatches: ReceivedBatch[] = [];
let receivedAuth: string[] = [];
let respondWith: (batch: ReceivedBatch) => Response = () =>
  HttpResponse.json({ accepted: 0, rejected: 0, errors: [] }, { status: 202 });

const server = setupServer(
  http.post('http://localhost:4000/v1/sessions/:id/events', async ({ request }) => {
    const batch = (await request.json()) as ReceivedBatch;
    receivedBatches.push(batch);
    receivedAuth.push(request.headers.get('authorization') ?? '');
    return respondWith(batch);
  }),
  http.post('http://localhost:4000/v1/sessions/:id/complete', async ({ request }) => {
    receivedAuth.push(request.headers.get('authorization') ?? '');
    return HttpResponse.json({
      aer_id: '01900000-0000-7000-8000-000000000001',
      canonical_hash: 'deadbeef',
      signing_key_id: 'abc123',
      findings_count: 0,
    }, { status: 200 });
  }),
  http.post('http://localhost:4000/v1/sessions/:id/abort', async ({ request }) => {
    receivedAuth.push(request.headers.get('authorization') ?? '');
    return HttpResponse.json({ status: 'terminated' }, { status: 200 });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());
beforeEach(() => {
  receivedBatches = [];
  receivedAuth = [];
  respondWith = () => HttpResponse.json({ accepted: 0, rejected: 0, errors: [] }, { status: 202 });
});

const sessionId = newUuidV7();

function makeClient(overrides: Partial<Parameters<typeof createAerClient>[0]> = {}): AerClient {
  return createAerClient({
    baseUrl: 'http://localhost:4000',
    sessionId,
    ingestToken: 'test-token-12char-plus-more',
    batchSize: 3,
    flushIntervalMs: 50,
    ...overrides,
  });
}

describe('createAerClient.emit', () => {
  it('batches events up to batchSize before sending', async () => {
    const c = makeClient({ batchSize: 3 });
    await c.emit('session.started', { agent: 'demo' });
    await c.emit('tool.started', { tool: 'lookup' });
    expect(receivedBatches).toHaveLength(0);
    await c.emit('tool.completed', { tool: 'lookup', ok: true });
    await c.flush();
    expect(receivedBatches).toHaveLength(1);
    expect(receivedBatches[0]).toHaveLength(3);
  });

  it('sends bearer auth header', async () => {
    const c = makeClient({ ingestToken: 'my-token-value-here' });
    await c.emit('session.started', {});
    await c.flush();
    expect(receivedAuth[0]).toBe('Bearer my-token-value-here');
  });

  it('populates required event fields automatically', async () => {
    const c = makeClient();
    await c.emit('tool.started', { tool: 'x' });
    await c.flush();
    const ev = receivedBatches[0]![0]!;
    expect(typeof ev['event_id']).toBe('string');
    expect(ev['agent_session_id']).toBe(sessionId);
    expect(typeof ev['timestamp_observed']).toBe('string');
    expect(ev['timestamp_observed']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(ev['source_type']).toBe('sdk');
    expect(ev['event_type']).toBe('tool.started');
    expect(ev['payload']).toEqual({ tool: 'x' });
  });

  it('flushes on close without dropping buffered events', async () => {
    const c = makeClient({ batchSize: 100 });
    await c.emit('session.started', {});
    await c.emit('session.ended', { status: 'completed' });
    await c.close();
    expect(receivedBatches).toHaveLength(1);
    expect(receivedBatches[0]).toHaveLength(2);
  });

  it('flushes periodically on the configured interval', async () => {
    vi.useFakeTimers();
    try {
      const c = makeClient({ batchSize: 100, flushIntervalMs: 1000 });
      await c.emit('session.started', {});
      await vi.advanceTimersByTimeAsync(1000);
      expect(receivedBatches).toHaveLength(1);
      await c.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries on 5xx with backoff', async () => {
    let attempt = 0;
    respondWith = () => {
      attempt += 1;
      if (attempt <= 2) return new HttpResponse(null, { status: 503 });
      return HttpResponse.json({ accepted: 1, rejected: 0, errors: [] }, { status: 202 });
    };
    const c = makeClient({ maxRetries: 3, retryBaseMs: 5 });
    await c.emit('session.started', {});
    await c.flush();
    expect(attempt).toBe(3);
  });

  it('does not retry on 4xx', async () => {
    let attempt = 0;
    respondWith = () => {
      attempt += 1;
      return HttpResponse.json({ error: 'bad' }, { status: 400 });
    };
    const c = makeClient({ maxRetries: 3 });
    await c.emit('session.started', {});
    await expect(c.flush()).rejects.toThrow();
    expect(attempt).toBe(1);
  });

  it('exposes accepted/rejected counts via flush result', async () => {
    respondWith = () =>
      HttpResponse.json({ accepted: 1, rejected: 1, errors: [{ index: 0 }] }, { status: 207 });
    const c = makeClient({ batchSize: 100 });
    await c.emit('session.started', {});
    await c.emit('tool.started', { tool: 'x' });
    const results = await c.flush();
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ accepted: 1, rejected: 1, errors: [{ index: 0 }] });
  });
});

describe('createAerClient.complete', () => {
  it('calls /complete with the bearer token and returns the aer_id', async () => {
    const c = makeClient();
    const result = await c.complete();
    expect(receivedAuth[0]).toBe('Bearer test-token-12char-plus-more');
    expect(result.aer_id).toBe('01900000-0000-7000-8000-000000000001');
    expect(result.canonical_hash).toBe('deadbeef');
    expect(result.findings_count).toBe(0);
  });

  it('flushes pending events before completing', async () => {
    const c = makeClient({ batchSize: 100 });
    await c.emit('session.started', {});
    await c.complete();
    expect(receivedBatches).toHaveLength(1);
  });
});

describe('createAerClient.abort', () => {
  it('flushes pending events then calls /abort', async () => {
    const c = makeClient({ batchSize: 100 });
    await c.emit('tool.started', { tool: 'crash' });
    await c.abort();
    expect(receivedBatches).toHaveLength(1);
    expect(receivedAuth[receivedAuth.length - 1]).toBe('Bearer test-token-12char-plus-more');
  });

  it('does not throw on 409 (already terminated)', async () => {
    server.use(
      http.post('http://localhost:4000/v1/sessions/:id/abort', async () => {
        return HttpResponse.json({ error: 'not_running' }, { status: 409 });
      }),
    );
    const c = makeClient();
    await expect(c.abort()).resolves.toBeUndefined();
  });
});

describe('createAerClient: 500-event chunk cap', () => {
  it('never posts more than 500 events in a single request even with a larger batchSize', async () => {
    const batchLengths: number[] = [];
    server.use(
      http.post('http://localhost:4000/v1/sessions/:id/events', async ({ request }) => {
        const batch = (await request.json()) as unknown[];
        batchLengths.push(batch.length);
        return HttpResponse.json({ accepted: batch.length, rejected: 0, errors: [] }, { status: 202 });
      }),
    );
    const c = makeClient({ batchSize: 1000, flushIntervalMs: 100_000 });
    for (let i = 0; i < 1500; i++) await c.emit('tool.started', { i });
    await c.close();
    expect(batchLengths.length).toBe(3);
    for (const n of batchLengths) expect(n).toBeLessThanOrEqual(500);
    expect(batchLengths.reduce((a, b) => a + b, 0)).toBe(1500);
  });
});

describe('createAerClient: internally-triggered flush results', () => {
  it('surfaces 207 rejections from a background (timer-triggered) flush via onIngestResult', async () => {
    respondWith = () => HttpResponse.json({ accepted: 1, rejected: 1, errors: [{ index: 0 }] }, { status: 207 });
    const results: Array<{ accepted: number; rejected: number }> = [];
    const c = createAerClient({
      baseUrl: 'http://localhost:4000',
      sessionId,
      ingestToken: 'test-token-12char-plus-more',
      batchSize: 100, // never crossed by a single emit; only the timer flushes
      flushIntervalMs: 20,
      onIngestResult: (r) => results.push(r),
    });
    await c.emit('tool.started', { tool: 'x' });
    await new Promise((r) => setTimeout(r, 60));
    await c.close();
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]).toEqual({ accepted: 1, rejected: 1, errors: [{ index: 0 }] });
  });

  it('surfaces 207 rejections from a size-triggered flush via onIngestResult', async () => {
    respondWith = () => HttpResponse.json({ accepted: 2, rejected: 1, errors: [{ index: 1 }] }, { status: 207 });
    const results: Array<{ accepted: number; rejected: number }> = [];
    const c = makeClient({ batchSize: 2, onIngestResult: (r) => results.push(r) });
    await c.emit('tool.started', {});
    await c.emit('tool.completed', {}); // crosses batchSize=2, flushes internally
    await c.close();
    expect(results).toEqual([{ accepted: 2, rejected: 1, errors: [{ index: 1 }] }]);
  });
});

describe('createAerClient: close()/flush() race', () => {
  it('close() awaits an in-flight flush even though the buffer has already drained', async () => {
    let release: (() => void) | undefined;
    server.use(
      http.post('http://localhost:4000/v1/sessions/:id/events', async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return HttpResponse.json({ accepted: 1, rejected: 0, errors: [] }, { status: 202 });
      }),
    );
    const c = makeClient({ batchSize: 1, flushIntervalMs: 100_000 });
    // emit() crosses batchSize=1 and awaits its own flush() internally, which
    // splices the buffer empty immediately and then blocks on the response.
    const emitPromise = c.emit('tool.started', {});
    await new Promise((r) => setTimeout(r, 0));

    let closeResolved = false;
    const closePromise = c.close().then(() => {
      closeResolved = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    // The buffer is already empty at this point (spliced by emit's flush), so
    // the buggy close() - gated on buffer.length > 0 - would have returned
    // immediately here without ever seeing the in-flight request.
    expect(closeResolved).toBe(false);
    release?.();
    await Promise.all([emitPromise, closePromise]);
    expect(closeResolved).toBe(true);
  });
});

describe('createAerClient: configurable timeout', () => {
  it('aborts a hanging request after requestTimeoutMs and treats it as a network error', async () => {
    let sawAbort = false;
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          sawAbort = true;
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      });
    }) as unknown as typeof fetch;

    const c = createAerClient({
      baseUrl: 'http://localhost:4000',
      sessionId,
      ingestToken: 'test-token-12char-plus-more',
      batchSize: 1,
      flushIntervalMs: 100_000,
      maxRetries: 0,
      requestTimeoutMs: 30,
      fetchImpl,
    });
    await expect(c.emit('tool.started', {})).rejects.toThrow();
    expect(sawAbort).toBe(true);
  });
});
