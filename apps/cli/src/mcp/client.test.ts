import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { McpApiClient, McpToolError, McpLocalRateLimitError, TokenBucket } from './client.js';

const BASE = 'http://test.local';
const KEY = 'test-key';

let lastAuth: string | null = null;
let lastUserAgent: string | null = null;
let lastClientHeader: string | null = null;

const server = setupServer(
  http.get(`${BASE}/v1/agents`, ({ request }) => {
    lastAuth = request.headers.get('authorization');
    lastUserAgent = request.headers.get('user-agent');
    lastClientHeader = request.headers.get('x-aer-client');
    return HttpResponse.json({ agents: [] });
  }),
  http.get(`${BASE}/v1/rate-limited`, () => new HttpResponse(null, { status: 429, headers: { 'retry-after': '7' } })),
  http.get(`${BASE}/v1/disabled`, () => HttpResponse.json({ error: 'mcp_access_disabled' }, { status: 403 })),
  http.get(`${BASE}/v1/admin-only`, () => HttpResponse.json({ error: 'mcp_requires_read_key' }, { status: 403 })),
  http.get(`${BASE}/v1/suspended`, () => HttpResponse.json({ error: 'tenant_suspended' }, { status: 403 })),
  http.get(`${BASE}/v1/broken`, () => HttpResponse.json({ message: 'something else went wrong' }, { status: 500 })),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('McpApiClient', () => {
  it('sends the bearer token, User-Agent and X-AER-Client headers', async () => {
    const client = new McpApiClient({ baseUrl: BASE, apiKey: KEY, clientVersion: '0.9.0' });
    await client.get('/v1/agents');
    expect(lastAuth).toBe(`Bearer ${KEY}`);
    expect(lastUserAgent).toBe('aer-cli/0.9.0');
    expect(lastClientHeader).toBe('aer-mcp/0.9.0');
  });

  it('maps a 429 to a McpToolError carrying retry_after_seconds from Retry-After', async () => {
    const client = new McpApiClient({ baseUrl: BASE, apiKey: KEY, clientVersion: '1.0.0' });
    await expect(client.get('/v1/rate-limited')).rejects.toMatchObject({ code: 'rate_limited', retryAfterSeconds: 7 });
  });

  it('maps mcp_access_disabled to a clear, non-crashing refusal', async () => {
    const client = new McpApiClient({ baseUrl: BASE, apiKey: KEY, clientVersion: '1.0.0' });
    await expect(client.get('/v1/disabled')).rejects.toMatchObject({
      code: 'mcp_access_disabled',
      message: expect.stringContaining('turned off'),
    });
  });

  it('maps mcp_requires_read_key to a clear refusal', async () => {
    const client = new McpApiClient({ baseUrl: BASE, apiKey: KEY, clientVersion: '1.0.0' });
    await expect(client.get('/v1/admin-only')).rejects.toMatchObject({ code: 'mcp_requires_read_key' });
  });

  it('maps tenant_suspended to "workspace is paused", not a raw code', async () => {
    const client = new McpApiClient({ baseUrl: BASE, apiKey: KEY, clientVersion: '1.0.0' });
    await expect(client.get('/v1/suspended')).rejects.toMatchObject({ message: expect.stringContaining('paused') });
  });

  it('falls back to a sanitized generic message for an unmapped error', async () => {
    const client = new McpApiClient({ baseUrl: BASE, apiKey: KEY, clientVersion: '1.0.0' });
    await expect(client.get('/v1/broken')).rejects.toMatchObject({ message: expect.stringContaining('something else went wrong') });
  });

  it('enforces its own local rate ceiling before ever making a request', async () => {
    const client = new McpApiClient({ baseUrl: BASE, apiKey: KEY, clientVersion: '1.0.0', maxRpm: 2 });
    await client.get('/v1/agents');
    await client.get('/v1/agents');
    await expect(client.get('/v1/agents')).rejects.toBeInstanceOf(McpLocalRateLimitError);
  });
});

describe('McpApiClient: CVE-2026-111497 (Brotli decoder RCE)', () => {
  // fetch() decodes a Brotli body lazily on first read, and a hostile or
  // compromised base_url picks Content-Encoding regardless of what was
  // requested. Garbage bytes rather than real Brotli, so an unguarded read
  // fails on JSON.parse with a DIFFERENT message than the CVE refusal,
  // proving the guard (not a parse failure) is what rejected it.
  it('refuses a compressed response without reading its body', async () => {
    server.use(
      http.get(`${BASE}/v1/compressed`, () => new HttpResponse(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-encoding': 'br' },
      })),
    );
    const client = new McpApiClient({ baseUrl: BASE, apiKey: KEY, clientVersion: '1.0.0' });
    await expect(client.get('/v1/compressed')).rejects.toThrow(/CVE-2026-111497/);
  });

  it('refuses a compressed error response without reading its body', async () => {
    server.use(
      http.get(`${BASE}/v1/compressed-error`, () => new HttpResponse(new Uint8Array([1, 2, 3]), {
        status: 500,
        headers: { 'content-encoding': 'br' },
      })),
    );
    const client = new McpApiClient({ baseUrl: BASE, apiKey: KEY, clientVersion: '1.0.0' });
    await expect(client.get('/v1/compressed-error')).rejects.toThrow(/CVE-2026-111497/);
  });
});

describe('TokenBucket', () => {
  it('refills after the 60s window elapses', () => {
    let now = 0;
    const bucket = new TokenBucket(1, () => now);
    bucket.take();
    expect(() => bucket.take()).toThrow(McpToolError);
    now = 60_001;
    expect(() => bucket.take()).not.toThrow();
  });
});
