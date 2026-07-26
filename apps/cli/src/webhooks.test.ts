import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import {
  listWebhooks,
  createWebhook,
  testWebhook,
  rotateWebhookSecret,
  deleteWebhook,
  listDeliveries,
} from './webhooks.js';

const BASE = 'http://test.local';
const KEY = 'test-key-abc';

let lastAuth: string | null = null;
let lastBody: unknown = null;

const server = setupServer(
  http.get(`${BASE}/v1/webhooks`, ({ request }) => {
    lastAuth = request.headers.get('authorization');
    return HttpResponse.json({ webhooks: [{ webhook_id: 'wh-1', url: 'https://x' }] });
  }),
  http.post(`${BASE}/v1/webhooks`, async ({ request }) => {
    lastAuth = request.headers.get('authorization');
    lastBody = await request.json();
    return HttpResponse.json({ webhook_id: 'wh-new', signing_secret: 'abc123' }, { status: 201 });
  }),
  http.post(`${BASE}/v1/webhooks/:id/test`, ({ request }) => {
    lastAuth = request.headers.get('authorization');
    return HttpResponse.json({ delivered: true, status: 200 });
  }),
  http.post(`${BASE}/v1/webhooks/:id/rotate-secret`, ({ request, params }) => {
    lastAuth = request.headers.get('authorization');
    return HttpResponse.json({
      webhook_id: params.id,
      signing_secret: 'a'.repeat(64),
      rotated_at: '2026-05-26T00:00:00Z',
    });
  }),
  http.delete(`${BASE}/v1/webhooks/:id`, ({ request }) => {
    lastAuth = request.headers.get('authorization');
    return new HttpResponse(null, { status: 204 });
  }),
  http.get(`${BASE}/v1/webhooks/:id/deliveries`, ({ request }) => {
    lastAuth = request.headers.get('authorization');
    const url = new URL(request.url);
    return HttpResponse.json({
      deliveries: [],
      _limit: url.searchParams.get('limit'),
    });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

describe('CLI webhooks', () => {
  it('list passes bearer token', async () => {
    const r = await listWebhooks({ baseUrl: BASE, apiKey: KEY }) as { webhooks: unknown[] };
    expect(lastAuth).toBe(`Bearer ${KEY}`);
    expect(r.webhooks).toHaveLength(1);
  });

  it('create sends URL + description + event types', async () => {
    await createWebhook({
      baseUrl: BASE, apiKey: KEY,
      url: 'https://hook.example/x',
      description: 'prod hook',
      eventTypes: ['findings.created'],
    });
    expect(lastBody).toEqual({
      url: 'https://hook.example/x',
      description: 'prod hook',
      event_types: ['findings.created'],
    });
  });

  it('create omits optional fields when not provided', async () => {
    await createWebhook({ baseUrl: BASE, apiKey: KEY, url: 'https://only-url' });
    expect(lastBody).toEqual({ url: 'https://only-url' });
  });

  it('rotate posts to /rotate-secret and returns new secret', async () => {
    const r = await rotateWebhookSecret({ baseUrl: BASE, apiKey: KEY, webhookId: 'wh-1' }) as { signing_secret: string };
    expect(r.signing_secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('test fires POST to /test', async () => {
    const r = await testWebhook({ baseUrl: BASE, apiKey: KEY, webhookId: 'wh-1' }) as { delivered: boolean };
    expect(r.delivered).toBe(true);
  });

  it('delete returns void on 204', async () => {
    await expect(deleteWebhook({ baseUrl: BASE, apiKey: KEY, webhookId: 'wh-1' })).resolves.toBeUndefined();
  });

  it('deliveries passes limit query param', async () => {
    const r = await listDeliveries({ baseUrl: BASE, apiKey: KEY, webhookId: 'wh-1', limit: 25 }) as { _limit: string };
    expect(r._limit).toBe('25');
  });

  it('throws on non-2xx', async () => {
    server.use(
      http.get(`${BASE}/v1/webhooks`, () => HttpResponse.json({ error: 'unauthorized' }, { status: 401 })),
    );
    await expect(listWebhooks({ baseUrl: BASE, apiKey: 'wrong' })).rejects.toThrow(/401/);
    server.resetHandlers();
  });
});
