import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdLogout } from './logout.js';
import { getCredential, setCredential } from './credentials-store.js';

const BASE_URL = 'https://api.test';
const CRED = { tenant_id: 't1', api_key: 'aer_secret_key_value', key_id: 'k1', role: 'write', expires_at: '2099-01-01T00:00:00Z' };

describe('cmdLogout', () => {
  let root: string;
  let env: Record<string, string | undefined>;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aer-logout-'));
    env = { HOME: root, XDG_CONFIG_HOME: undefined };
    out = [];
    err = [];
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function deps(fetchImpl: typeof fetch) {
    return { env, fetchImpl, print: (l: string) => out.push(l), printErr: (l: string) => err.push(l) };
  }

  it('says nothing to revoke when not logged in, exit 0', async () => {
    const fetchImpl = vi.fn();
    const code = await cmdLogout({ baseUrl: BASE_URL }, deps(fetchImpl));
    expect(code).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('revokes server-side and removes the local entry on success', async () => {
    setCredential(BASE_URL, CRED, env);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const code = await cmdLogout({ baseUrl: BASE_URL }, deps(fetchImpl));
    expect(code).toBe(0);
    expect(getCredential(BASE_URL, env)).toBeUndefined();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/v1/cli/logout`);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${CRED.api_key}`);
  });

  it('removes the local entry even when the API is unreachable, and says so', async () => {
    setCredential(BASE_URL, CRED, env);
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const code = await cmdLogout({ baseUrl: BASE_URL }, deps(fetchImpl));
    expect(code).toBe(0);
    expect(getCredential(BASE_URL, env)).toBeUndefined();
    expect(err.join('\n')).toMatch(/unreachable|could not reach/i);
  });

  it('403 not_a_cli_key: removes locally and says to revoke in Settings', async () => {
    setCredential(BASE_URL, CRED, env);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'not_a_cli_key' }), { status: 403 }),
    );
    const code = await cmdLogout({ baseUrl: BASE_URL }, deps(fetchImpl));
    expect(code).toBe(0);
    expect(getCredential(BASE_URL, env)).toBeUndefined();
    expect(out.join('\n')).toMatch(/Settings/);
  });

  it('an unexpected error status still removes the local entry', async () => {
    setCredential(BASE_URL, CRED, env);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    const code = await cmdLogout({ baseUrl: BASE_URL }, deps(fetchImpl));
    expect(code).toBe(0);
    expect(getCredential(BASE_URL, env)).toBeUndefined();
  });

  it('never prints the api key', async () => {
    setCredential(BASE_URL, CRED, env);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await cmdLogout({ baseUrl: BASE_URL }, deps(fetchImpl));
    expect([...out, ...err].join('\n')).not.toContain(CRED.api_key);
  });

  it('P3: hints at other stored base URLs when nothing matches the resolved one', async () => {
    setCredential('https://other.test', CRED, env);
    const fetchImpl = vi.fn();
    await cmdLogout({ baseUrl: BASE_URL }, deps(fetchImpl));
    expect(out.join('\n')).toContain('https://other.test');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('P3: --all revokes and removes every stored entry', async () => {
    setCredential(BASE_URL, CRED, env);
    setCredential('https://other.test', { ...CRED, tenant_id: 't2' }, env);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const code = await cmdLogout({ baseUrl: BASE_URL, all: true }, deps(fetchImpl));
    expect(code).toBe(0);
    expect(getCredential(BASE_URL, env)).toBeUndefined();
    expect(getCredential('https://other.test', env)).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('P3: --all with nothing stored says so without any network call', async () => {
    const fetchImpl = vi.fn();
    const code = await cmdLogout({ baseUrl: BASE_URL, all: true }, deps(fetchImpl));
    expect(code).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out.join('\n')).toMatch(/not logged in/i);
  });
});

describe('revokeCliKey', () => {
  it('resolves true on an ok response', async () => {
    const { revokeCliKey } = await import('./logout.js');
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(revokeCliKey(BASE_URL, 'k', fetchImpl)).resolves.toBe(true);
  });

  it('resolves false, never throws, on a network error', async () => {
    const { revokeCliKey } = await import('./logout.js');
    const fetchImpl = vi.fn().mockRejectedValue(new Error('down'));
    await expect(revokeCliKey(BASE_URL, 'k', fetchImpl)).resolves.toBe(false);
  });

  it('resolves false on a non-ok response', async () => {
    const { revokeCliKey } = await import('./logout.js');
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    await expect(revokeCliKey(BASE_URL, 'k', fetchImpl)).resolves.toBe(false);
  });
});
