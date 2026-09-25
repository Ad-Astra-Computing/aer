import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  credentialsPaths,
  normalizeBaseUrl,
  readCredentialsFile,
  writeCredentialsFile,
  getCredential,
  setCredential,
  removeCredential,
  listCredentialBaseUrls,
  isExpired,
  isValidStoredCredential,
  CredentialsSymlinkError,
  CredentialsCorruptError,
  type StoredCredential,
} from './credentials-store.js';

const CRED: StoredCredential = {
  tenant_id: 'tenant-1',
  api_key: 'aer_cli_super_secret_key_value',
  key_id: 'key-1',
  role: 'write',
  expires_at: '2099-01-01T00:00:00Z',
};

describe('credentials-store', () => {
  let root: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aer-cred-'));
    env = { HOME: root, XDG_CONFIG_HOME: undefined };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves under ~/.config/aer by default', () => {
    const paths = credentialsPaths(env);
    expect(paths.dir).toBe(join(root, '.config', 'aer'));
    expect(paths.file).toBe(join(root, '.config', 'aer', 'credentials.json'));
  });

  it('honors XDG_CONFIG_HOME when set', () => {
    const xdg = join(root, 'xdg-config');
    const paths = credentialsPaths({ HOME: root, XDG_CONFIG_HOME: xdg });
    expect(paths.dir).toBe(join(xdg, 'aer'));
  });

  it('normalizes a base URL by stripping a trailing slash', () => {
    expect(normalizeBaseUrl('https://api.aer.run/')).toBe('https://api.aer.run');
    expect(normalizeBaseUrl('https://api.aer.run')).toBe('https://api.aer.run');
  });

  it('reading a missing file returns {} rather than throwing', () => {
    const paths = credentialsPaths(env);
    expect(readCredentialsFile(paths)).toEqual({});
  });

  it('writes the directory 0700 and the file 0600', () => {
    const paths = credentialsPaths(env);
    writeCredentialsFile(paths, { 'https://api.aer.run': CRED });
    expect(statSync(paths.dir).mode & 0o777).toBe(0o700);
    expect(statSync(paths.file).mode & 0o777).toBe(0o600);
  });

  it('round-trips through set/get/remove, keyed by base URL', () => {
    setCredential('https://api.aer.run/', CRED, env);
    expect(getCredential('https://api.aer.run', env)).toEqual(CRED);
    removeCredential('https://api.aer.run', env);
    expect(getCredential('https://api.aer.run', env)).toBeUndefined();
  });

  it('removing a base URL with no stored entry is a no-op, not an error', () => {
    expect(() => removeCredential('https://api.aer.run', env)).not.toThrow();
  });

  it('keeps separate entries per base URL', () => {
    setCredential('https://api.aer.run', CRED, env);
    setCredential('https://staging.aer.run', { ...CRED, tenant_id: 'tenant-2' }, env);
    expect(getCredential('https://api.aer.run', env)?.tenant_id).toBe('tenant-1');
    expect(getCredential('https://staging.aer.run', env)?.tenant_id).toBe('tenant-2');
  });

  it('writes atomically: no partial file is ever visible at the final path', () => {
    const paths = credentialsPaths(env);
    writeCredentialsFile(paths, { a: CRED });
    // second write replaces wholesale; readers only ever see a complete document
    writeCredentialsFile(paths, { b: CRED });
    const onDisk = JSON.parse(readFileSync(paths.file, 'utf8'));
    expect(onDisk).toEqual({ b: CRED });
  });

  it('a stray temp file from an aborted write never becomes the real file', () => {
    const paths = credentialsPaths(env);
    writeCredentialsFile(paths, { a: CRED });
    // simulate a leftover temp file from a previous crashed write
    writeFileSync(join(paths.dir, '.credentials.json.deadbeef.tmp'), 'garbage');
    expect(readCredentialsFile(paths)).toEqual({ a: CRED });
  });

  it('refuses to read through a symlinked credentials file', () => {
    const paths = credentialsPaths(env);
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    const real = join(root, 'elsewhere.json');
    writeFileSync(real, JSON.stringify({ a: CRED }));
    symlinkSync(real, paths.file);
    expect(() => readCredentialsFile(paths)).toThrow(CredentialsSymlinkError);
  });

  it('refuses to write through a symlinked credentials file', () => {
    const paths = credentialsPaths(env);
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    const real = join(root, 'elsewhere.json');
    writeFileSync(real, JSON.stringify({}));
    symlinkSync(real, paths.file);
    expect(() => writeCredentialsFile(paths, { a: CRED })).toThrow(CredentialsSymlinkError);
    // the real target was never touched
    expect(JSON.parse(readFileSync(real, 'utf8'))).toEqual({});
  });

  it('refuses to read or write when the config directory itself is a symlink', () => {
    const paths = credentialsPaths(env);
    const realDir = join(root, 'elsewhere-dir');
    mkdirSync(realDir, { recursive: true });
    mkdirSync(join(root, '.config'), { recursive: true });
    symlinkSync(realDir, paths.dir);
    expect(() => readCredentialsFile(paths)).toThrow(CredentialsSymlinkError);
    expect(() => writeCredentialsFile(paths, { a: CRED })).toThrow(CredentialsSymlinkError);
  });

  it('isExpired compares expires_at against the clock', () => {
    const now = () => Date.parse('2050-01-01T00:00:00Z');
    expect(isExpired({ ...CRED, expires_at: '2020-01-01T00:00:00Z' }, now)).toBe(true);
    expect(isExpired({ ...CRED, expires_at: '2099-01-01T00:00:00Z' }, now)).toBe(false);
  });

  it('isExpired treats an unparsable date as not expired rather than always-expired', () => {
    expect(isExpired({ ...CRED, expires_at: 'not-a-date' })).toBe(false);
  });
});

describe('corrupt credentials file is never silently clobbered', () => {
  let root: string;
  let env: Record<string, string | undefined>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aer-cred-corrupt-'));
    env = { HOME: root, XDG_CONFIG_HOME: undefined };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('invalid JSON is moved aside to a timestamped .corrupt-<suffix> file and refused, not overwritten', () => {
    const paths = credentialsPaths(env);
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.file, 'not json at all {{{');
    let caught: unknown;
    try {
      readCredentialsFile(paths);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CredentialsCorruptError);
    const err = caught as InstanceType<typeof CredentialsCorruptError>;
    expect(err.movedTo).toMatch(/\.corrupt-\d{8}T\d{6}Z$/);
    expect(existsSync(paths.file)).toBe(false);
    expect(readFileSync(err.movedTo, 'utf8')).toBe('not json at all {{{');
  });

  it('valid JSON that is not an object (array, string, number) is also refused', () => {
    const paths = credentialsPaths(env);
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.file, JSON.stringify([1, 2, 3]));
    expect(() => readCredentialsFile(paths)).toThrow(CredentialsCorruptError);
  });

  it('getCredential propagates the corruption instead of returning undefined', () => {
    const paths = credentialsPaths(env);
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.file, '{ broken');
    expect(() => getCredential('https://api.aer.run', env)).toThrow(CredentialsCorruptError);
  });

  it('setCredential never overwrites a corrupt file silently', () => {
    const paths = credentialsPaths(env);
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    writeFileSync(paths.file, '{ broken');
    let caught: unknown;
    try {
      setCredential('https://api.aer.run', CRED, env);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CredentialsCorruptError);
    const err = caught as InstanceType<typeof CredentialsCorruptError>;
    // the corrupt content was moved aside, not replaced with the new entry
    expect(existsSync(paths.file)).toBe(false);
    expect(readFileSync(err.movedTo, 'utf8')).toBe('{ broken');
  });

  it('never overwrites an earlier quarantined file: a second corruption gets its own name', () => {
    const paths = credentialsPaths(env);
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });

    writeFileSync(paths.file, 'first corrupt content');
    let firstErr: InstanceType<typeof CredentialsCorruptError> | undefined;
    try {
      readCredentialsFile(paths);
    } catch (e) {
      firstErr = e as InstanceType<typeof CredentialsCorruptError>;
    }
    expect(firstErr).toBeDefined();

    // a fresh corrupt file lands at the same path again
    writeFileSync(paths.file, 'second corrupt content');
    let secondErr: InstanceType<typeof CredentialsCorruptError> | undefined;
    try {
      readCredentialsFile(paths);
    } catch (e) {
      secondErr = e as InstanceType<typeof CredentialsCorruptError>;
    }
    expect(secondErr).toBeDefined();

    expect(secondErr!.movedTo).not.toBe(firstErr!.movedTo);
    // the first quarantined file was never touched by the second quarantine
    expect(readFileSync(firstErr!.movedTo, 'utf8')).toBe('first corrupt content');
    expect(readFileSync(secondErr!.movedTo, 'utf8')).toBe('second corrupt content');
  });
});

describe('normalizeBaseUrl via URL', () => {
  it('lowercases the host', () => {
    expect(normalizeBaseUrl('https://API.AER.RUN')).toBe('https://api.aer.run');
  });

  it('drops a trailing slash', () => {
    expect(normalizeBaseUrl('https://api.aer.run/')).toBe('https://api.aer.run');
  });

  it('preserves a non-root path', () => {
    expect(normalizeBaseUrl('https://gateway.example/aer/')).toBe('https://gateway.example/aer');
  });

  it('refuses a base URL with embedded credentials rather than silently dropping them', () => {
    expect(() => normalizeBaseUrl('https://user:pass@api.aer.run')).toThrow(/embedded credentials/);
  });

  it('falls back to a trailing-slash strip for a value new URL() cannot parse', () => {
    expect(normalizeBaseUrl('not-a-url/')).toBe('not-a-url');
  });
});

describe('isValidStoredCredential', () => {
  it('accepts a well-formed entry', () => {
    expect(isValidStoredCredential(CRED)).toBe(true);
  });

  it('rejects an entry missing api_key, instead of letting a caller crash on it', () => {
    const { api_key: _drop, ...rest } = CRED;
    expect(isValidStoredCredential(rest)).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(isValidStoredCredential('just a string')).toBe(false);
    expect(isValidStoredCredential(null)).toBe(false);
  });

  it('rejects an unparsable expires_at', () => {
    expect(isValidStoredCredential({ ...CRED, expires_at: 'whenever' })).toBe(false);
  });

  it('getCredential treats a shape-invalid stored entry as absent, not a crash', () => {
    const root = mkdtempSync(join(tmpdir(), 'aer-cred-shape-'));
    const env = { HOME: root, XDG_CONFIG_HOME: undefined };
    try {
      const paths = credentialsPaths(env);
      writeCredentialsFile(paths, { 'https://api.aer.run': { role: 'write' } as unknown as StoredCredential });
      expect(getCredential('https://api.aer.run', env)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('listCredentialBaseUrls', () => {
  it('lists only structurally valid entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'aer-cred-list-'));
    const env = { HOME: root, XDG_CONFIG_HOME: undefined };
    try {
      const paths = credentialsPaths(env);
      writeCredentialsFile(paths, {
        'https://api.aer.run': CRED,
        'https://staging.aer.run': { role: 'write' } as unknown as StoredCredential,
      });
      expect(listCredentialBaseUrls(env)).toEqual(['https://api.aer.run']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is empty when nothing is stored', () => {
    const root = mkdtempSync(join(tmpdir(), 'aer-cred-list2-'));
    const env = { HOME: root, XDG_CONFIG_HOME: undefined };
    try {
      expect(listCredentialBaseUrls(env)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('warns on read when the file is more permissive than 0600 (POSIX only)', () => {
  it('calls warn() with the path when the mode is loose', () => {
    if (process.platform === 'win32') return; // no POSIX mode bits to check
    const root = mkdtempSync(join(tmpdir(), 'aer-cred-mode-'));
    const env = { HOME: root, XDG_CONFIG_HOME: undefined };
    try {
      const paths = credentialsPaths(env);
      writeCredentialsFile(paths, { 'https://api.aer.run': CRED });
      chmodSync(paths.file, 0o644);
      const warnings: string[] = [];
      readCredentialsFile(paths, { warn: (m) => warnings.push(m) });
      expect(warnings.some((w) => w.includes(paths.file))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not warn when the mode is already 0600', () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'aer-cred-mode-ok-'));
    const env = { HOME: root, XDG_CONFIG_HOME: undefined };
    try {
      const paths = credentialsPaths(env);
      writeCredentialsFile(paths, { 'https://api.aer.run': CRED });
      const warnings: string[] = [];
      readCredentialsFile(paths, { warn: (m) => warnings.push(m) });
      expect(warnings).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
