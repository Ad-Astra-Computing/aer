import { describe, it, expect } from 'vitest';
import { HttpSentinelLocalApiClient, SentinelLocalApiError } from './http-client.js';

// A tiny fake server keyed by method+path, standing in for the not-yet-built
// server routes - exercises the documented wire contract against this
// client's one real implementation.
function fakeServer(routes: Record<string, { status: number; json?: unknown }>): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = new URL(String(url)).pathname;
    const key = `${method} ${path}`;
    const route = routes[key];
    if (!route) throw new Error(`unexpected request ${key}`);
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      json: async () => route.json ?? {},
    } as Response;
  }) as unknown as typeof fetch;
}

describe('HttpSentinelLocalApiClient.register', () => {
  it('posts the documented fields and returns the registration response', async () => {
    const fetchFn = fakeServer({
      'POST /v1/fleet/local-sensors': {
        status: 201,
        json: { sensor_source_id: 's1', push_token: 't1', ingest_url: 'https://api.aer.run/v1/sentinel/local-poll/s1', expected_claim_id: 'c1' },
      },
    });
    const client = new HttpSentinelLocalApiClient({ baseUrl: 'https://api.aer.run', apiKey: 'k', fetchFn });
    const res = await client.register({ device_id: 'd1', consent_version: 'v1', source_platform: 'linux' });
    expect(res.sensor_source_id).toBe('s1');
    expect(res.expected_claim_id).toBe('c1');
  });

  it('throws SentinelLocalApiError on a non-2xx response', async () => {
    const fetchFn = fakeServer({ 'POST /v1/fleet/local-sensors': { status: 409 } });
    const client = new HttpSentinelLocalApiClient({ baseUrl: 'https://api.aer.run', apiKey: 'k', fetchFn });
    await expect(
      client.register({ device_id: 'd1', consent_version: 'v1', source_platform: 'linux' }),
    ).rejects.toThrow(SentinelLocalApiError);
  });
});

describe('HttpSentinelLocalApiClient.disable / eraseObservations', () => {
  it('disable tolerates an already-gone (404) registration', async () => {
    const fetchFn = fakeServer({ 'DELETE /v1/fleet/local-sensors/s1': { status: 404 } });
    const client = new HttpSentinelLocalApiClient({ baseUrl: 'https://api.aer.run', apiKey: 'k', fetchFn });
    await expect(client.disable('s1')).resolves.toBeUndefined();
  });

  it('erase sends expected_claim_id in the body', async () => {
    let capturedBody: unknown;
    const fetchFn = (async (_url: string | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    const client = new HttpSentinelLocalApiClient({ baseUrl: 'https://api.aer.run', apiKey: 'k', fetchFn });
    await client.eraseObservations('s1', 'claim-123');
    expect(capturedBody).toEqual({ expected_claim_id: 'claim-123' });
  });
});

describe('HttpSentinelLocalApiClient.push', () => {
  it('reports retryable for 429/503', async () => {
    const fetchFn = fakeServer({ 'POST /v1/sentinel/local-poll/s1': { status: 429 } });
    const client = new HttpSentinelLocalApiClient({ baseUrl: 'https://api.aer.run', apiKey: 'k', fetchFn });
    const result = await client.push('s1', 'push-token', []);
    expect(result).toEqual({ status: 429, ok: false, retryable: true });
  });

  it('reports ok for 200', async () => {
    const fetchFn = fakeServer({ 'POST /v1/sentinel/local-poll/s1': { status: 200 } });
    const client = new HttpSentinelLocalApiClient({ baseUrl: 'https://api.aer.run', apiKey: 'k', fetchFn });
    const result = await client.push('s1', 'push-token', []);
    expect(result).toEqual({ status: 200, ok: true, retryable: false });
  });
});
