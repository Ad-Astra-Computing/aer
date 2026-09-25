import { describe, it, expect, vi } from 'vitest';
import {
  startDeviceLogin,
  pollForToken,
  runDeviceLogin,
  formatUserCode,
  sanitizeHostname,
  DeviceLoginError,
  type DeviceStartResponse,
} from './device-login.js';

const START: DeviceStartResponse = {
  device_code: 'dc-1',
  user_code: 'ABCDEFGH',
  verification_uri: 'https://aer.run/device',
  verification_uri_complete: 'https://aer.run/device?user_code=ABCDEFGH',
  expires_in: 600,
  interval: 5,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function immediateSleep(): (ms: number) => Promise<void> {
  return () => Promise.resolve();
}

describe('startDeviceLogin', () => {
  it('posts client + hostname and returns the grant', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, START));
    const result = await startDeviceLogin({
      baseUrl: 'https://api.test',
      client: 'aer-cli/1.0.0',
      hostname: 'my-box',
      fetchImpl,
    });
    expect(result).toEqual(START);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/cli/device');
    expect(JSON.parse(init.body as string)).toEqual({ client: 'aer-cli/1.0.0', hostname: 'my-box' });
  });

  it('omits hostname when not given', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, START));
    await startDeviceLogin({ baseUrl: 'https://api.test', client: 'aer-cli/1.0.0', fetchImpl });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ client: 'aer-cli/1.0.0' });
  });

  it('throws a DeviceLoginError on a non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(429, { error: 'rate_limited' }));
    await expect(
      startDeviceLogin({ baseUrl: 'https://api.test', client: 'aer-cli/1.0.0', fetchImpl }),
    ).rejects.toThrow(DeviceLoginError);
  });
});

describe('pollForToken branches', () => {
  it('authorization_pending: keeps polling without erroring', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: 'authorization_pending' }))
      .mockResolvedValueOnce(jsonResponse(400, { error: 'authorization_pending' }))
      .mockResolvedValueOnce(jsonResponse(201, {
        api_key: 'secret-key', key_id: 'k1', tenant_id: 't1', role: 'write', expires_at: '2099-01-01T00:00:00Z',
      }));
    const result = await pollForToken(START, {
      baseUrl: 'https://api.test', client: 'aer-cli/1.0.0', fetchImpl, sleep: immediateSleep(),
    });
    expect(result.api_key).toBe('secret-key');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('slow_down: does not throw, and the caller keeps polling', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { error: 'slow_down' }))
      .mockResolvedValueOnce(jsonResponse(201, {
        api_key: 'k', key_id: 'k1', tenant_id: 't1', role: 'write', expires_at: '2099-01-01T00:00:00Z',
      }));
    const sleeps: number[] = [];
    const result = await pollForToken(START, {
      baseUrl: 'https://api.test',
      client: 'aer-cli/1.0.0',
      fetchImpl,
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
    });
    expect(result.api_key).toBe('k');
    // second sleep grew by the +5s backoff over the base 5s interval
    expect(sleeps[0]).toBe(5000);
    expect(sleeps[1]).toBe(10000);
  });

  it('access_denied: rejects with that code and a human message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, { error: 'access_denied' }));
    await expect(
      pollForToken(START, { baseUrl: 'https://api.test', client: 'aer-cli/1.0.0', fetchImpl, sleep: immediateSleep() }),
    ).rejects.toMatchObject({ code: 'access_denied' });
  });

  it('expired_token from the server: rejects with that code', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, { error: 'expired_token' }));
    await expect(
      pollForToken(START, { baseUrl: 'https://api.test', client: 'aer-cli/1.0.0', fetchImpl, sleep: immediateSleep() }),
    ).rejects.toMatchObject({ code: 'expired_token' });
  });

  it('local deadline: stops polling once expires_in has elapsed, without a further request', async () => {
    let clock = 0;
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, { error: 'authorization_pending' }));
    const shortGrant: DeviceStartResponse = { ...START, expires_in: 1, interval: 1 };
    await expect(
      pollForToken(shortGrant, {
        baseUrl: 'https://api.test',
        client: 'aer-cli/1.0.0',
        fetchImpl,
        now: () => clock,
        sleep: (ms) => { clock += ms; return Promise.resolve(); },
      }),
    ).rejects.toMatchObject({ code: 'expired_token' });
  });

  it('201 exactly once: resolves and stops calling fetch', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(201, {
      api_key: 'k', key_id: 'k1', tenant_id: 't1', role: 'write', expires_at: '2099-01-01T00:00:00Z',
    }));
    const result = await pollForToken(START, {
      baseUrl: 'https://api.test', client: 'aer-cli/1.0.0', fetchImpl, sleep: immediateSleep(),
    });
    expect(result).toEqual({ api_key: 'k', key_id: 'k1', tenant_id: 't1', role: 'write', expires_at: '2099-01-01T00:00:00Z' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('429 rate limiting: backs off and keeps polling rather than failing', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, {}))
      .mockResolvedValueOnce(jsonResponse(201, {
        api_key: 'k', key_id: 'k1', tenant_id: 't1', role: 'write', expires_at: '2099-01-01T00:00:00Z',
      }));
    const sleeps: number[] = [];
    const result = await pollForToken(START, {
      baseUrl: 'https://api.test',
      client: 'aer-cli/1.0.0',
      fetchImpl,
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
    });
    expect(result.api_key).toBe('k');
    expect(sleeps[1]).toBeGreaterThan(sleeps[0] ?? 0);
  });

  it('403 cli_device_key_limit_reached: a specific, actionable error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(403, { error: 'cli_device_key_limit_reached' }));
    await expect(
      pollForToken(START, { baseUrl: 'https://api.test', client: 'aer-cli/1.0.0', fetchImpl, sleep: immediateSleep() }),
    ).rejects.toMatchObject({ code: 'cli_device_key_limit_reached' });
  });

  it('an unrecognized status is a generic failure, not a silent retry forever', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, {}));
    let clock = 0;
    await expect(
      pollForToken({ ...START, expires_in: 100 }, {
        baseUrl: 'https://api.test', client: 'aer-cli/1.0.0', fetchImpl,
        now: () => clock, sleep: (ms) => { clock += ms; return Promise.resolve(); },
      }),
    ).rejects.toThrow(DeviceLoginError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('runDeviceLogin', () => {
  it('calls onPrompt exactly once with the start response, before polling', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, START))
      .mockResolvedValueOnce(jsonResponse(201, {
        api_key: 'k', key_id: 'k1', tenant_id: 't1', role: 'write', expires_at: '2099-01-01T00:00:00Z',
      }));
    const onPrompt = vi.fn();
    await runDeviceLogin({
      baseUrl: 'https://api.test', client: 'aer-cli/1.0.0', fetchImpl, sleep: immediateSleep(), onPrompt,
    });
    expect(onPrompt).toHaveBeenCalledTimes(1);
    expect(onPrompt).toHaveBeenCalledWith(START);
  });
});

describe('formatUserCode', () => {
  it('inserts a dash after the fourth character', () => {
    expect(formatUserCode('ABCDEFGH')).toBe('ABCD-EFGH');
  });

  it('leaves an already-dashed code as-is (normalized)', () => {
    expect(formatUserCode('abcd-efgh')).toBe('ABCD-EFGH');
  });

  it('does not dash a short code', () => {
    expect(formatUserCode('AB')).toBe('AB');
  });
});

describe('sanitizeHostname', () => {
  it('strips control characters', () => {
    expect(sanitizeHostname('host\x07name\n')).toBe('hostname');
  });

  it('truncates to 64 characters', () => {
    const long = 'x'.repeat(200);
    expect(sanitizeHostname(long)).toHaveLength(64);
  });
});
