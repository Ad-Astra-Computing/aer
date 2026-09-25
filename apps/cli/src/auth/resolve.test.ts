import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAuth, resolveBaseUrl } from './resolve.js';
import { setCredential } from './credentials-store.js';

const DEFAULT_BASE_URL = 'https://api.aer.run';

describe('resolveAuth precedence', () => {
  let root: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aer-resolve-'));
    env = { HOME: root, XDG_CONFIG_HOME: undefined };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('falls back to none when nothing is configured', () => {
    const result = resolveAuth({ env, cfg: {}, defaultBaseUrl: DEFAULT_BASE_URL });
    expect(result.source).toBe('none');
    expect(result.apiKey).toBeUndefined();
    expect(result.baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it('uses the credentials file when nothing else is set', () => {
    setCredential(DEFAULT_BASE_URL, {
      tenant_id: 'tenant-cred', api_key: 'key-cred', key_id: 'k1', role: 'write', expires_at: '2099-01-01T00:00:00Z',
    }, env);
    const result = resolveAuth({ env, cfg: {}, defaultBaseUrl: DEFAULT_BASE_URL });
    expect(result.source).toBe('credentials');
    expect(result.apiKey).toBe('key-cred');
    expect(result.tenantId).toBe('tenant-cred');
  });

  it('aer.config.json base_url selects which credentials-file entry applies', () => {
    setCredential('https://staging.aer.run', {
      tenant_id: 'tenant-staging', api_key: 'key-staging', key_id: 'k1', role: 'write', expires_at: '2099-01-01T00:00:00Z',
    }, env);
    const result = resolveAuth({ env, cfg: { base_url: 'https://staging.aer.run' }, defaultBaseUrl: DEFAULT_BASE_URL });
    expect(result.baseUrl).toBe('https://staging.aer.run');
    expect(result.apiKey).toBe('key-staging');
  });

  it('an explicit env key wins over the credentials file, even when both are set', () => {
    setCredential(DEFAULT_BASE_URL, {
      tenant_id: 'tenant-cred', api_key: 'key-cred', key_id: 'k1', role: 'write', expires_at: '2099-01-01T00:00:00Z',
    }, env);
    const result = resolveAuth({
      env: { ...env, AER_TENANT_API_KEY: 'key-env' },
      cfg: {},
      defaultBaseUrl: DEFAULT_BASE_URL,
    });
    expect(result.source).toBe('env');
    expect(result.apiKey).toBe('key-env');
  });

  it('AER_API_KEY works the same as AER_TENANT_API_KEY', () => {
    const result = resolveAuth({ env: { ...env, AER_API_KEY: 'key-env-2' }, cfg: {}, defaultBaseUrl: DEFAULT_BASE_URL });
    expect(result.apiKey).toBe('key-env-2');
    expect(result.source).toBe('env');
  });

  it('an explicit flag wins over everything, including env', () => {
    setCredential(DEFAULT_BASE_URL, {
      tenant_id: 'tenant-cred', api_key: 'key-cred', key_id: 'k1', role: 'write', expires_at: '2099-01-01T00:00:00Z',
    }, env);
    const result = resolveAuth({
      env: { ...env, AER_TENANT_API_KEY: 'key-env' },
      cfg: {},
      apiKeyFlag: 'key-flag',
      defaultBaseUrl: DEFAULT_BASE_URL,
    });
    expect(result.source).toBe('flag');
    expect(result.apiKey).toBe('key-flag');
  });

  it('tenant id prefers env AER_TENANT_ID over aer.config.json when an env key is used', () => {
    const result = resolveAuth({
      env: { ...env, AER_TENANT_API_KEY: 'key-env', AER_TENANT_ID: 'tenant-env' },
      cfg: { tenant_id: 'tenant-cfg' },
      defaultBaseUrl: DEFAULT_BASE_URL,
    });
    expect(result.tenantId).toBe('tenant-env');
  });

  it('tenant id falls back to aer.config.json when AER_TENANT_ID is unset', () => {
    const result = resolveAuth({
      env: { ...env, AER_TENANT_API_KEY: 'key-env' },
      cfg: { tenant_id: 'tenant-cfg' },
      defaultBaseUrl: DEFAULT_BASE_URL,
    });
    expect(result.tenantId).toBe('tenant-cfg');
  });

  it('flags an expired credentials-file entry rather than silently using it', () => {
    setCredential(DEFAULT_BASE_URL, {
      tenant_id: 'tenant-cred', api_key: 'key-cred', key_id: 'k1', role: 'write', expires_at: '2020-01-01T00:00:00Z',
    }, env);
    const result = resolveAuth({ env, cfg: {}, defaultBaseUrl: DEFAULT_BASE_URL });
    expect(result.source).toBe('credentials');
    expect(result.expired).toBe(true);
  });
});

describe('P1-1: refuse a flag/env key sent toward a cfg-only base URL that differs from the default', () => {
  let root: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aer-resolve-mismatch-'));
    env = { HOME: root, XDG_CONFIG_HOME: undefined };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('flags the mismatch when an env key meets a cfg base_url that differs from default', () => {
    const result = resolveAuth({
      env: { ...env, AER_TENANT_API_KEY: 'key-env' },
      cfg: { base_url: 'https://cloned-repo.example' },
      defaultBaseUrl: DEFAULT_BASE_URL,
    });
    expect(result.baseUrlMismatch).toBeDefined();
    expect(result.baseUrlMismatch).toContain('AER_BASE_URL');
  });

  it('flags the same mismatch for an explicit --api-key style flag', () => {
    const result = resolveAuth({
      env,
      cfg: { base_url: 'https://cloned-repo.example' },
      apiKeyFlag: 'key-flag',
      defaultBaseUrl: DEFAULT_BASE_URL,
    });
    expect(result.baseUrlMismatch).toBeDefined();
  });

  it('does not flag when the cfg base_url equals the default', () => {
    const result = resolveAuth({
      env: { ...env, AER_TENANT_API_KEY: 'key-env' },
      cfg: { base_url: DEFAULT_BASE_URL },
      defaultBaseUrl: DEFAULT_BASE_URL,
    });
    expect(result.baseUrlMismatch).toBeUndefined();
  });

  it('does not flag when the user explicitly set AER_BASE_URL themselves (confirming intent)', () => {
    const result = resolveAuth({
      env: { ...env, AER_TENANT_API_KEY: 'key-env', AER_BASE_URL: 'https://cloned-repo.example' },
      cfg: { base_url: 'https://cloned-repo.example' },
      defaultBaseUrl: DEFAULT_BASE_URL,
    });
    expect(result.baseUrlMismatch).toBeUndefined();
  });

  it('does not flag when the user explicitly passed --base-url themselves', () => {
    const result = resolveAuth({
      env: { ...env, AER_TENANT_API_KEY: 'key-env' },
      cfg: { base_url: 'https://cloned-repo.example' },
      baseUrlFlag: 'https://cloned-repo.example',
      defaultBaseUrl: DEFAULT_BASE_URL,
    });
    expect(result.baseUrlMismatch).toBeUndefined();
  });

  it('does not flag a credentials-file-sourced key: the credential is scoped to that exact host', () => {
    setCredential('https://cloned-repo.example', {
      tenant_id: 'tenant-cred', api_key: 'key-cred', key_id: 'k1', role: 'write', expires_at: '2099-01-01T00:00:00Z',
    }, env);
    const result = resolveAuth({
      env,
      cfg: { base_url: 'https://cloned-repo.example' },
      defaultBaseUrl: DEFAULT_BASE_URL,
    });
    expect(result.source).toBe('credentials');
    expect(result.baseUrlMismatch).toBeUndefined();
  });

  it('does not flag when there is no cfg base_url at all (default applies)', () => {
    const result = resolveAuth({
      env: { ...env, AER_TENANT_API_KEY: 'key-env' },
      cfg: {},
      defaultBaseUrl: DEFAULT_BASE_URL,
    });
    expect(result.baseUrlMismatch).toBeUndefined();
  });
});

describe('resolveBaseUrl', () => {
  const env = {};
  it('flag beats env beats config beats default', () => {
    expect(resolveBaseUrl({ env: { AER_BASE_URL: 'https://env' }, cfg: { base_url: 'https://cfg' }, baseUrlFlag: 'https://flag', defaultBaseUrl: 'https://default' })).toBe('https://flag');
    expect(resolveBaseUrl({ env: { AER_BASE_URL: 'https://env' }, cfg: { base_url: 'https://cfg' }, defaultBaseUrl: 'https://default' })).toBe('https://env');
    expect(resolveBaseUrl({ env, cfg: { base_url: 'https://cfg' }, defaultBaseUrl: 'https://default' })).toBe('https://cfg');
    expect(resolveBaseUrl({ env, cfg: {}, defaultBaseUrl: 'https://default' })).toBe('https://default');
  });
});
