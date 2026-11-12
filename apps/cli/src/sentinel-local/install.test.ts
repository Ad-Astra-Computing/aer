import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstall, CONSENT_VERSION, resolveScriptPathFromMetaUrl } from './install.js';
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
      ...(req as object),
    })) as unknown as SentinelLocalApiClient['register'],
    disable: vi.fn(),
    eraseObservations: vi.fn(),
    getSensors: vi.fn(async () => []),
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
      consentAcknowledged: true,
      print: () => {},
    });

    expect(result.sensorSourceId).toBe('s1');
    expect(client.register).toHaveBeenCalledWith(
      expect.objectContaining({ consent_version: CONSENT_VERSION, source_platform: 'linux' }),
    );
    expect(CONSENT_VERSION).toBe('v1');

    const cred = readPushCredential(env);
    expect(cred?.sensorSourceId).toBe('s1');
    expect(cred).not.toHaveProperty('expectedClaimId');

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
      consentAcknowledged: true,
      print: () => {},
    });
    expect(result.deviceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses to install without consent, before any registration happens', async () => {
    const execFn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const client = fakeClient();
    await expect(
      runInstall({
        apiClient: client,
        execFn,
        env,
        platform: 'linux',
        execPath: '/usr/bin/node',
        scriptPath: '/opt/aer/dist/main.js',
        consentAcknowledged: false,
        print: () => {},
      }),
    ).rejects.toThrow(/consent/i);
    expect(client.register).not.toHaveBeenCalled();
  });

  it('refuses a second install without uninstalling first', async () => {
    const execFn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const client = fakeClient();
    const opts = {
      apiClient: client, execFn, env, platform: 'linux' as const,
      execPath: '/usr/bin/node', scriptPath: '/opt/aer/dist/main.js',
      consentAcknowledged: true, print: () => {},
    };
    await runInstall(opts);
    await expect(runInstall(opts)).rejects.toThrow(/already installed/i);
  });

  it('regenerates the device id when --regenerate-device-id is set', async () => {
    const execFn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const first = await runInstall({
      apiClient: fakeClient(), execFn, env, platform: 'linux',
      execPath: '/usr/bin/node', scriptPath: '/opt/aer/dist/main.js',
      consentAcknowledged: true, print: () => {},
    });
    // Simulate a fresh machine state (uninstall deletes the local config but
    // never the shared device-id file) and reinstall with regeneration.
    const { deleteSentinelLocalConfig } = await import('./state.js');
    deleteSentinelLocalConfig(env);
    const second = await runInstall({
      apiClient: fakeClient(), execFn, env, platform: 'linux',
      execPath: '/usr/bin/node', scriptPath: '/opt/aer/dist/main.js',
      consentAcknowledged: true, regenerateDeviceId: true, print: () => {},
    });
    expect(second.deviceId).not.toBe(first.deviceId);
  });

  it('rolls back (disables) the server-side registration when local setup fails afterward', async () => {
    const execFn = vi.fn(async () => { throw new Error('systemctl is unavailable'); });
    const client = fakeClient();
    await expect(
      runInstall({
        apiClient: client, execFn, env, platform: 'linux',
        execPath: '/usr/bin/node', scriptPath: '/opt/aer/dist/main.js',
        consentAcknowledged: true, print: () => {},
      }),
    ).rejects.toThrow(/systemctl/);
    expect(client.disable).toHaveBeenCalledWith('s1');
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
      consentAcknowledged: true,
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
        consentAcknowledged: true,
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
      consentAcknowledged: true,
      print: () => {},
    });
    const config = readSentinelLocalConfig(env);
    expect(config?.codexHome).toEqual({ kind: 'absolute', value: '/home/dev/.codex-alt' });
  });
});

describe('resolveScriptPathFromMetaUrl: real bundled dist/ layout', () => {
  it('resolves to the sibling main.js next to the running module - never one directory up', () => {
    // The published package bundles every source module (including
    // install.ts) into one file, dist/main.js (bundle.mjs -> esbuild,
    // entry src/bin.ts, outfile dist/main.js). At runtime this module's own
    // import.meta.url therefore IS dist/main.js's url - there is no separate
    // dist/sentinel-local/install.js for it to live "one level below".
    const metaUrl = 'file:///home/user/.npm-global/lib/node_modules/@adastracomputing/aer/dist/main.js';
    expect(resolveScriptPathFromMetaUrl(metaUrl)).toBe(
      '/home/user/.npm-global/lib/node_modules/@adastracomputing/aer/dist/main.js',
    );
  });

  it('never climbs above dist/ (the old bug: join(dirname, "..", "main.js"))', () => {
    const metaUrl = 'file:///opt/aer/dist/main.js';
    const resolved = resolveScriptPathFromMetaUrl(metaUrl);
    expect(resolved).toBe('/opt/aer/dist/main.js');
    expect(resolved.startsWith('/opt/aer/dist/')).toBe(true);
  });
});
