import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { ingestJsonlStream } from './ingest.js';
import { Readable } from 'node:stream';

let batches: Array<Array<Record<string, unknown>>> = [];

const server = setupServer(
  http.post('http://localhost:4000/v1/sessions/:id/events', async ({ request }) => {
    const body = (await request.json()) as Array<Record<string, unknown>>;
    batches.push(body);
    return HttpResponse.json({ accepted: body.length, rejected: 0, errors: [] }, { status: 202 });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
beforeEach(() => {
  batches = [];
});

function jsonl(objects: unknown[]): Readable {
  return Readable.from(objects.map((o) => JSON.stringify(o) + '\n'));
}

describe('ingestJsonlStream', () => {
  it('posts events in batches of the configured size', async () => {
    const events = Array.from({ length: 7 }, (_, i) => ({ n: i }));
    const r = await ingestJsonlStream({
      stream: jsonl(events),
      baseUrl: 'http://localhost:4000',
      sessionId: '00000000-0000-7000-8000-000000000000',
      token: 't',
      batchSize: 3,
    });
    expect(batches).toHaveLength(3);
    expect(batches.map((b) => b.length)).toEqual([3, 3, 1]);
    expect(r.accepted).toBe(7);
  });

  it('skips malformed lines with a count', async () => {
    const src = Readable.from(['{"a":1}\n', 'not json\n', '{"b":2}\n']);
    const r = await ingestJsonlStream({
      stream: src,
      baseUrl: 'http://localhost:4000',
      sessionId: '00000000-0000-7000-8000-000000000000',
      token: 't',
      batchSize: 10,
    });
    expect(r.parseErrors).toBe(1);
    expect(r.accepted).toBe(2);
  });

  it('sends the bearer token', async () => {
    let authHeader = '';
    server.use(
      http.post('http://localhost:4000/v1/sessions/:id/events', ({ request }) => {
        authHeader = request.headers.get('authorization') ?? '';
        return HttpResponse.json({ accepted: 1, rejected: 0, errors: [] }, { status: 202 });
      }),
    );
    await ingestJsonlStream({
      stream: jsonl([{ x: 1 }]),
      baseUrl: 'http://localhost:4000',
      sessionId: '00000000-0000-7000-8000-000000000000',
      token: 'my-bearer',
      batchSize: 10,
    });
    expect(authHeader).toBe('Bearer my-bearer');
  });
});
