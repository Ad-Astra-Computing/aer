import { describe, it, expect, vi } from 'vitest';
import { HttpSentinelLocalApiClient, SentinelLocalApiError, fetchTenantName } from './http-client.js';
import { CLI_VERSION } from '../version.generated.js';

// A tiny fake server keyed by method+path, standing in for the real server
// routes - shapes here are taken directly from the private monorepo's own
// schemas (local-poll-ingest.ts's LocalPollIngestBody, fleet-local-
// sensors.ts's responses, fleet.ts's GET /v1/fleet/sensors), never invented.
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
  it('posts the documented fields and returns exactly the server response shape (no expected_claim_id)', async () => {
    const fetchFn = fakeServer({
      'POST /v1/fleet/local-sensors': {
        status: 201,
        json: { sensor_source_id: 's1', push_token: 't1', ingest_url: 'https://api.aer.run/v1/sentinel/local-poll/s1' },
      },
    });
    const client = new HttpSentinelLocalApiClient({ baseUrl: 'https://api.aer.run', apiKey: 'k', fetchFn });
    const res = await client.register({ device_id: 'd1', consent_version: 'v1', source_platform: 'linux' });
    expect(res.sensor_source_id).toBe('s1');
    expect(res).not.toHaveProperty('expected_claim_id');
  });

  it('throws SentinelLocalApiError on a non-2xx response with no parseable body', async () => {
    const fetchFn = fakeServer({ 'POST /v1/fleet/local-sensors': { status: 409 } });
    const client = new HttpSentinelLocalApiClient({ baseUrl: 'https://api.aer.run', apiKey: 'k', fetchFn });
    await expect(
      client.register({ device_id: 'd1', consent_version: 'v1', source_platform: 'linux' }),
    ).rejects.toThrow(SentinelLocalApiError);
  });

  it('surfaces the server\'s same-claim device_already_registered remedy text (should-fix 3)', async () => {
    const fetchFn = fakeServer({
      'POST /v1/fleet/local-sensors': {
        status: 409,
        json: {
          error: 'device_already_registered',
          sensor_source_id: 's1',
          message: 'this device id is already registered to sensor s1; if this is a different machine, re-run install with --regenerate-device-id',
        },
      },
    });
    const client = new HttpSentinelLocalApiClient({ baseUrl: 'https://api.aer.run', apiKey: 'k', fetchFn });
    await expect(
      client.register({ device_id: 'd1', consent_version: 'v1', source_platform: 'linux' }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('--regenerate-device-id') });
  });

  it('surfaces the server\'s stale-other-owner device_already_registered remedy text (should-fix 3)', async () => {
    const fetchFn = fakeServer({
      'POST /v1/fleet/local-sensors': {
        status: 409,
        json: {
          error: 'device_already_registered',
          message: 'a stale registration from a previous owner is blocking this device; ask an admin, or wait for it to clear automatically',
        },
      },
    });
    const client = new HttpSentinelLocalApiClient({ baseUrl: 'https://api.aer.run', apiKey: 'k', fetchFn });
    await expect(
      client.register({ device_id: 'd1', consent_version: 'v1', source_platform: 'linux' }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('ask an admin') });
  });

  it('surfaces consent_version_outdated with the server\'s current version (should-fix 3)', async () => {
    const fetchFn = fakeServer({
      'POST /v1/fleet/local-sensors': { status: 400, json: { error: 'consent_version_outdated', current: 'v2' } },
    });
    const client = new HttpSentinelLocalApiClient({ baseUrl: 'https://api.aer.run', apiKey: 'k', fetchFn });
    await expect(
      client.register({ device_id: 'd1', consent_version: 'v1', source_platform: 'linux' }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('v2') });
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

  it('throws SentinelLocalApiError(409) on device_release_conflict', async () => {
    const fetchFn = fakeServer({
      'DELETE /v1/fleet/local-sensors/s1/observations': { status: 409, json: { error: 'device_release_conflict' } },
    });
    const client = new HttpSentinelLocalApiClient({ baseUrl: 'https://api.aer.run', apiKey: 'k', fetchFn });
    await expect(client.eraseObservations('s1', 'stale-claim')).rejects.toMatchObject({ status: 409 });
  });
});

describe('HttpSentinelLocalApiClient.getSensors', () => {
  it('GET /v1/fleet/sensors and returns the sensors array, including claim_id', async () => {
    const fetchFn = fakeServer({
      'GET /v1/fleet/sensors': {
        status: 200,
        json: {
          sensors: [
            {
              sensor_source_id: 's1', kind: 'local_poll', environment_id: null, enabled: 1,
              last_ingested_at: null, device_id: 'd1', device_label: null, claim_id: 'claim-current',
            },
          ],
        },
      },
    });
    const client = new HttpSentinelLocalApiClient({ baseUrl: 'https://api.aer.run', apiKey: 'k', fetchFn });
    const sensors = await client.getSensors();
    expect(sensors).toHaveLength(1);
    expect(sensors[0]?.claim_id).toBe('claim-current');
  });
});

describe('HttpSentinelLocalApiClient.push', () => {
  it('sends { poller_version, rows } - never an "observations" wrapper key', async () => {
    let capturedBody: unknown;
    const fetchFn = (async (_url: string | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    const client = new HttpSentinelLocalApiClient({ baseUrl: 'https://api.aer.run', apiKey: 'k', fetchFn });
    await client.push('s1', 'push-token', []);
    expect(capturedBody).toEqual({ poller_version: CLI_VERSION, rows: [] });
    expect(capturedBody).not.toHaveProperty('observations');
  });

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

  // S3: push-auth.ts's sensorPushAuthStatus returns 403 for both
  // tenant_suspended (reversible) and tenant_deleted (terminal) - the
  // caller needs the body's `error` code to tell them apart.
  it('surfaces the error code from a 403 body', async () => {
    const fetchFn = fakeServer({ 'POST /v1/sentinel/local-poll/s1': { status: 403, json: { error: 'tenant_deleted' } } });
    const client = new HttpSentinelLocalApiClient({ baseUrl: 'https://api.aer.run', apiKey: 'k', fetchFn });
    const result = await client.push('s1', 'push-token', []);
    expect(result).toEqual({ status: 403, ok: false, retryable: false, errorCode: 'tenant_deleted' });
  });
});

describe('HttpSentinelLocalApiClient: request timeout', () => {
  it('aborts the underlying fetch after timeoutMs', async () => {
    vi.useFakeTimers();
    try {
      let sawSignal: AbortSignal | undefined;
      const fetchFn = ((_url: string | URL, init?: RequestInit) => {
        sawSignal = init?.signal as AbortSignal | undefined;
        return new Promise((_resolve, reject) => {
          sawSignal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }) as unknown as typeof fetch;
      const client = new HttpSentinelLocalApiClient({ baseUrl: 'https://api.aer.run', apiKey: 'k', fetchFn, timeoutMs: 1000 });
      const pending = client.push('s1', 'push-token', []);
      const assertion = expect(pending).rejects.toThrow('aborted');
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(sawSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('fetchTenantName', () => {
  it('reads tenant_name off GET /v1/tenant/lifecycle (blocking 1)', async () => {
    const fetchFn = fakeServer({
      'GET /v1/tenant/lifecycle': { status: 200, json: { tenant_name: 'Acme Robotics', suspended_at: null } },
    });
    const name = await fetchTenantName({ baseUrl: 'https://api.aer.run', apiKey: 'k', fetchFn });
    expect(name).toBe('Acme Robotics');
  });

  it('throws on a non-2xx response', async () => {
    const fetchFn = fakeServer({ 'GET /v1/tenant/lifecycle': { status: 401 } });
    await expect(fetchTenantName({ baseUrl: 'https://api.aer.run', apiKey: 'k', fetchFn })).rejects.toThrow(
      SentinelLocalApiError,
    );
  });

  it('throws when the response has no tenant_name', async () => {
    const fetchFn = fakeServer({ 'GET /v1/tenant/lifecycle': { status: 200, json: {} } });
    await expect(fetchTenantName({ baseUrl: 'https://api.aer.run', apiKey: 'k', fetchFn })).rejects.toThrow(
      SentinelLocalApiError,
    );
  });
});
