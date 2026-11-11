import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstall, CONSENT_VERSION } from './install.js';
import { readSentinelLocalConfig, readPushCredential } from './state.js';
import { systemdUnitPath, launchdPlistPath } from './platform-process.js';
import type { SentinelLocalApiClient } from './http-client.js';

let dir: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aer-sentinel-install-test-'));
  env = { HOME: dir };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeClient(): SentinelLocalApiClient {
  return {
    register: vi.fn(async (req) => ({
      sensor_source_id: 's1',
      push_token: 'tok1',
      ingest_url: `https://api.aer.run/v1/sentinel/local-poll/s1`,
      expected_claim_id: 'claim1',
      ...(req as object),
    })) as unknown as SentinelLocalApiClient['register'],
    disable: vi.fn(),
    eraseObservations: vi.fn(),
    push: vi.fn(),
  } as unknown as SentinelLocalApiClient;
}

describe('runInstall (linux)', () => {
  it('registers, writes the push credential, writes the systemd unit, and starts the daemon', async () => {
    const execFn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const client = fakeClient();
    const result = await runInstall({
      apiClient: client,
      execFn,
      env,
      platform: 'linux',
      execPath: '/usr/bin/node',
      scriptPath: '/opt/aer/dist/main.js',
      print: () => {},
    });

    expect(result.sensorSourceId).toBe('s1');
    expect(client.register).toHaveBeenCalledWith(
      expect.objectContaining({ consent_version: CONSENT_VERSION, source_platform: 'linux' }),
    );

    const cred = readPushCredential(env);
    expect(cred?.sensorSourceId).toBe('s1');
    expect(cred?.expectedClaimId).toBe('claim1');

    const unitPath = systemdUnitPath(env);
    expect(existsSync(unitPath)).toBe(true);
    expect(readFileSync(unitPath, 'utf8')).toContain('ExecStart=/usr/bin/node /opt/aer/dist/main.js sentinel-local run-daemon');

    const config = readSentinelLocalConfig(env);
    expect(config?.consentVersion).toBe(CONSENT_VERSION);

    expect(execFn).toHaveBeenCalledWith('systemctl', expect.arrayContaining(['enable']));
  });

  it('mints a device-id if one is not already present', async () => {
    const execFn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const result = await runInstall({
      apiClient: fakeClient(),
      execFn,
      env,
      platform: 'linux',
      execPath: '/usr/bin/node',
      scriptPath: '/opt/aer/dist/main.js',
      print: () => {},
    });
    expect(result.deviceId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('runInstall (macos)', () => {
  it('writes the launchd plist and bootstraps it', async () => {
    const execFn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    await runInstall({
      apiClient: fakeClient(),
      execFn,
      env,
      platform: 'macos',
      execPath: '/usr/local/bin/node',
      scriptPath: '/opt/aer/dist/main.js',
      print: () => {},
    });
    const plistPath = launchdPlistPath(env);
    expect(existsSync(plistPath)).toBe(true);
    expect(execFn).toHaveBeenCalledWith('launchctl', expect.arrayContaining(['bootstrap']));
  });
});

describe('runInstall: CODEX_HOME capture', () => {
  it('fails install outright for a CODEX_HOME containing a control character', async () => {
    const execFn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    await expect(
      runInstall({
        apiClient: fakeClient(),
        execFn,
        env: { ...env, CODEX_HOME: '/a\nb' },
        platform: 'linux',
        execPath: '/usr/bin/node',
        scriptPath: '/opt/aer/dist/main.js',
        print: () => {},
      }),
    ).rejects.toThrow(/install aborted/);
  });

  it('records an absolute CODEX_HOME into sentinel-local.json', async () => {
    const execFn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    await runInstall({
      apiClient: fakeClient(),
      execFn,
      env: { ...env, CODEX_HOME: '/home/dev/.codex-alt' },
      platform: 'linux',
      execPath: '/usr/bin/node',
      scriptPath: '/opt/aer/dist/main.js',
      print: () => {},
    });
    const config = readSentinelLocalConfig(env);
    expect(config?.codexHome).toEqual({ kind: 'absolute', value: '/home/dev/.codex-alt' });
  });
});
