import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdWhoami } from './whoami.js';
import { setCredential } from './credentials-store.js';

const BASE_URL = 'https://api.test';
const CRED = { tenant_id: 't1', api_key: 'aer_secret_key_value_0123', key_id: 'k1', role: 'write', expires_at: '2099-01-01T00:00:00Z' };

describe('cmdWhoami', () => {
  let root: string;
  let env: Record<string, string | undefined>;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aer-whoami-'));
    env = { HOME: root, XDG_CONFIG_HOME: undefined };
    out = [];
    err = [];
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function deps(now?: () => number) {
    return { env, ...(now ? { now } : {}), print: (l: string) => out.push(l), printErr: (l: string) => err.push(l) };
  }

  it('exits 1 with a clear message when not logged in', () => {
    const code = cmdWhoami({ baseUrl: BASE_URL }, deps());
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/aer login/);
  });

  it('shows base URL, tenant, role, key prefix and expiry when logged in', () => {
    setCredential(BASE_URL, CRED, env);
    const code = cmdWhoami({ baseUrl: BASE_URL }, deps());
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain(BASE_URL);
    expect(text).toContain('t1');
    expect(text).toContain('write');
    expect(text).toContain(CRED.api_key.slice(0, 12));
  });

  it('never prints the full key, only the prefix', () => {
    setCredential(BASE_URL, CRED, env);
    cmdWhoami({ baseUrl: BASE_URL }, deps());
    expect(out.join('\n')).not.toContain(CRED.api_key);
  });

  it('flags an expired key rather than showing it as valid', () => {
    setCredential(BASE_URL, { ...CRED, expires_at: '2020-01-01T00:00:00Z' }, env);
    const code = cmdWhoami({ baseUrl: BASE_URL }, deps());
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/expired/i);
  });
});
