import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdLogin } from './login.js';
import { getCredential } from './credentials-store.js';

const BASE_URL = 'https://api.test';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const START = {
  device_code: 'dc-1',
  user_code: 'ABCDEFGH',
  verification_uri: 'https://aer.run/device',
  verification_uri_complete: 'https://aer.run/device?user_code=ABCDEFGH',
  expires_in: 600,
  interval: 5,
};

const GRANT = {
  api_key: 'aer_super_secret_value_xyz',
  key_id: 'key-1',
  tenant_id: 'tenant-1',
  role: 'write',
  expires_at: '2099-01-01T00:00:00Z',
};

describe('cmdLogin', () => {
  let root: string;
  let env: Record<string, string | undefined>;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aer-login-'));
    env = { HOME: root, XDG_CONFIG_HOME: undefined };
    out = [];
    err = [];
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function baseDeps(fetchImpl: typeof fetch) {
    return {
      env,
      defaultBaseUrl: 'https://api.aer.run',
      clientVersion: '1.0.0',
      fetchImpl,
      sleep: () => Promise.resolve(),
      print: (l: string) => out.push(l),
      printErr: (l: string) => err.push(l),
      hostname: () => 'my-machine',
      hasDisplay: () => false,
      openBrowser: vi.fn(),
    };
  }

  it('completes the flow and saves the credential, keyed by the base URL used', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, START))
      .mockResolvedValueOnce(jsonResponse(201, GRANT));
    const code = await cmdLogin({ baseUrlFlag: BASE_URL }, baseDeps(fetchImpl));
    expect(code).toBe(0);
    const cred = getCredential(BASE_URL, env);
    expect(cred).toEqual({
      tenant_id: 'tenant-1', api_key: GRANT.api_key, key_id: 'key-1', role: 'write', expires_at: GRANT.expires_at,
    });
  });

  it('never prints the api key, in stdout or stderr', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, START))
      .mockResolvedValueOnce(jsonResponse(201, GRANT));
    await cmdLogin({ baseUrlFlag: BASE_URL }, baseDeps(fetchImpl));
    const everything = [...out, ...err].join('\n');
    expect(everything).not.toContain(GRANT.api_key);
  });

  it('prints the verification URL and a dashed user code', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, START))
      .mockResolvedValueOnce(jsonResponse(201, GRANT));
    await cmdLogin({ baseUrlFlag: BASE_URL }, baseDeps(fetchImpl));
    const everything = out.join('\n');
    expect(everything).toContain('https://aer.run/device');
    expect(everything).toContain('ABCD-EFGH');
    // never the prefilled complete URL: the code must be typed
    expect(everything).not.toContain('verification_uri_complete');
    expect(everything).not.toContain('?user_code=');
  });

  it('opens the browser only when there is a display and --no-browser was not passed', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, START))
      .mockResolvedValueOnce(jsonResponse(201, GRANT));
    const deps = baseDeps(fetchImpl);
    deps.hasDisplay = () => true;
    await cmdLogin({ baseUrlFlag: BASE_URL }, deps);
    expect(deps.openBrowser).toHaveBeenCalledWith('https://aer.run/device');
  });

  it('never opens the browser with --no-browser, even with a display', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, START))
      .mockResolvedValueOnce(jsonResponse(201, GRANT));
    const deps = baseDeps(fetchImpl);
    deps.hasDisplay = () => true;
    await cmdLogin({ baseUrlFlag: BASE_URL, noBrowser: true }, deps);
    expect(deps.openBrowser).not.toHaveBeenCalled();
  });

  it('never requires a display: works with hasDisplay() false (SSH)', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, START))
      .mockResolvedValueOnce(jsonResponse(201, GRANT));
    const code = await cmdLogin({ baseUrlFlag: BASE_URL }, baseDeps(fetchImpl));
    expect(code).toBe(0);
  });

  it('a browser-open failure never fails the login', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, START))
      .mockResolvedValueOnce(jsonResponse(201, GRANT));
    const deps = baseDeps(fetchImpl);
    deps.hasDisplay = () => true;
    deps.openBrowser = vi.fn(() => { throw new Error('no browser available'); });
    const code = await cmdLogin({ baseUrlFlag: BASE_URL }, deps);
    expect(code).toBe(0);
  });

  it('returns exit 1 and a clean message on denial, without saving a credential', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, START))
      .mockResolvedValueOnce(jsonResponse(400, { error: 'access_denied' }));
    const code = await cmdLogin({ baseUrlFlag: BASE_URL }, baseDeps(fetchImpl));
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('denied');
    expect(getCredential(BASE_URL, env)).toBeUndefined();
  });

  it('sends the sanitized hostname to /v1/cli/device', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, START))
      .mockResolvedValueOnce(jsonResponse(201, GRANT));
    const deps = baseDeps(fetchImpl);
    deps.hostname = () => 'weird\x07host\nname'.repeat(10);
    await cmdLogin({ baseUrlFlag: BASE_URL }, deps);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string) as { hostname: string };
    expect(sent.hostname).toHaveLength(64);
    expect(sent.hostname).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  it('falls back to AER_BASE_URL then the default base URL', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, START))
      .mockResolvedValueOnce(jsonResponse(201, GRANT));
    const deps = baseDeps(fetchImpl);
    deps.env = { ...env, AER_BASE_URL: 'https://env.test' };
    await cmdLogin({}, deps);
    expect(getCredential('https://env.test', deps.env)).toBeDefined();
  });
});
