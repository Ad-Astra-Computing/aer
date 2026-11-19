import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUninstall } from './uninstall.js';
import { runStatus } from './status.js';
import {
  writePushCredential, readPushCredential,
  writeSentinelLocalConfig, readSentinelLocalConfig,
  appendToOutbox, readOutbox,
} from './state.js';
import { systemdUnitPath, launchdPlistPath } from './platform-process.js';
import { SentinelLocalApiError, type SentinelLocalApiClient, type SensorListRow } from './http-client.js';

let dir: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aer-sentinel-uninstall-test-'));
  env = { HOME: dir };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeClient(sensors: SensorListRow[] = []): SentinelLocalApiClient {
  return {
    register: vi.fn(),
    disable: vi.fn(),
    eraseObservations: vi.fn(),
    getSensors: vi.fn(async () => sensors),
    push: vi.fn(),
  };
}

function sensorRow(overrides: Partial<SensorListRow> = {}): SensorListRow {
  return {
    sensor_source_id: 's1', kind: 'local_poll', environment_id: null, enabled: 1,
    last_ingested_at: null, device_id: 'd1', device_label: null, claim_id: 'claim-current',
    ...overrides,
  };
}

const outboxRow = {
  observation_id: 'a'.repeat(64),
  observed_at: '2026-01-01T00:00:00Z',
  destination_evidence: 'none' as const,
  destination_family: null,
  tool: 'claude_code' as const,
  instrumentation: 'none' as const,
};

describe('runUninstall', () => {
  it('deletes the push credential but never the device id', async () => {
    writePushCredential({ sensorSourceId: 's1', pushToken: 't', ingestUrl: 'u' }, env);
    const execFn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const client = fakeClient();
    await runUninstall({ apiClient: client, execFn, env, erase: false, platform: 'linux', print: () => {} });
    expect(readPushCredential(env)).toBeUndefined();
    expect(client.disable).toHaveBeenCalledWith('s1');
    expect(client.eraseObservations).not.toHaveBeenCalled();
  });

  it('fetches the CURRENT claim id via GET /v1/fleet/sensors at erase time (never a cached one)', async () => {
    writePushCredential({ sensorSourceId: 's1', pushToken: 't', ingestUrl: 'u' }, env);
    const execFn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const client = fakeClient([sensorRow({ claim_id: 'claim-fresh' })]);
    await runUninstall({ apiClient: client, execFn, env, erase: true, platform: 'linux', print: () => {} });
    expect(client.getSensors).toHaveBeenCalled();
    expect(client.eraseObservations).toHaveBeenCalledWith('s1', 'claim-fresh');
  });

  it('surfaces a 409 device_release_conflict as a real error, not a silent retry', async () => {
    writePushCredential({ sensorSourceId: 's1', pushToken: 't', ingestUrl: 'u' }, env);
    const execFn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const client = fakeClient([sensorRow({ claim_id: 'claim-stale' })]);
    (client.eraseObservations as ReturnType<typeof vi.fn>).mockRejectedValue(
      new SentinelLocalApiError('erase failed: 409', 409),
    );
    await expect(
      runUninstall({ apiClient: client, execFn, env, erase: true, platform: 'linux', print: () => {} }),
    ).rejects.toThrow(/409|device_release_conflict/);
  });

  it('still removes local artifacts when the server-side disable() call fails (should-fix 4)', async () => {
    writePushCredential({ sensorSourceId: 's1', pushToken: 't', ingestUrl: 'u' }, env);
    writeSentinelLocalConfig(
      { deviceId: 'd1', consentVersion: 'v1', installedAt: 'x', sourcePlatform: 'linux', codexHome: { kind: 'unset' } },
      env,
    );
    const unitPath = systemdUnitPath(env);
    const { atomicWriteFile } = await import('./state.js');
    atomicWriteFile(unitPath, '[Unit]\n');

    const execFn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const client = fakeClient();
    (client.disable as ReturnType<typeof vi.fn>).mockRejectedValue(
      new SentinelLocalApiError('disable failed: 403', 403),
    );
    const printed: string[] = [];
    await expect(
      runUninstall({ apiClient: client, execFn, env, erase: false, platform: 'linux', print: (l) => printed.push(l) }),
    ).resolves.toBeUndefined();

    expect(existsSync(unitPath)).toBe(false);
    expect(readPushCredential(env)).toBeUndefined();
    expect(readSentinelLocalConfig(env)).toBeUndefined();
    expect(printed.some((l) => /warning/i.test(l) && l.includes('403'))).toBe(true);
  });

  it('tolerates a missing/broken unit without failing the rest of uninstall', async () => {
    writePushCredential({ sensorSourceId: 's1', pushToken: 't', ingestUrl: 'u' }, env);
    const execFn = vi.fn(async () => { throw new Error('no such unit'); });
    const client = fakeClient();
    await expect(runUninstall({ apiClient: client, execFn, env, erase: false, platform: 'linux', print: () => {} })).resolves.toBeUndefined();
    expect(client.disable).toHaveBeenCalled();
  });

  // S1: local cleanup must run even when the erase network call itself
  // fails (not just a 409 from the server) - otherwise the unit/plist and
  // credential are left behind, and on macOS the daemon can resurrect at
  // the next login.
  it('still removes local artifacts when getSensors() throws during --erase, and surfaces the failure (S1)', async () => {
    writePushCredential({ sensorSourceId: 's1', pushToken: 't', ingestUrl: 'u' }, env);
    writeSentinelLocalConfig(
      { deviceId: 'd1', consentVersion: 'v1', installedAt: 'x', sourcePlatform: 'linux', codexHome: { kind: 'unset' } },
      env,
    );
    const unitPath = systemdUnitPath(env);
    const { atomicWriteFile } = await import('./state.js');
    atomicWriteFile(unitPath, '[Unit]\n');

    const execFn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const client = fakeClient();
    (client.getSensors as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network unreachable'));

    await expect(
      runUninstall({ apiClient: client, execFn, env, erase: true, platform: 'linux', print: () => {} }),
    ).rejects.toThrow(/network unreachable/);

    expect(existsSync(unitPath)).toBe(false);
    expect(readPushCredential(env)).toBeUndefined();
    expect(readSentinelLocalConfig(env)).toBeUndefined();
  });

  it('still removes local artifacts when eraseObservations() 409s, and surfaces the failure (S1)', async () => {
    writePushCredential({ sensorSourceId: 's1', pushToken: 't', ingestUrl: 'u' }, env);
    writeSentinelLocalConfig(
      { deviceId: 'd1', consentVersion: 'v1', installedAt: 'x', sourcePlatform: 'linux', codexHome: { kind: 'unset' } },
      env,
    );
    const execFn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const client = fakeClient([sensorRow({ claim_id: 'claim-stale' })]);
    (client.eraseObservations as ReturnType<typeof vi.fn>).mockRejectedValue(
      new SentinelLocalApiError('erase failed: 409', 409),
    );

    await expect(
      runUninstall({ apiClient: client, execFn, env, erase: true, platform: 'linux', print: () => {} }),
    ).rejects.toThrow(/409|device_release_conflict/);

    expect(readPushCredential(env)).toBeUndefined();
    expect(readSentinelLocalConfig(env)).toBeUndefined();
  });

  it('is a no-op server-side when there is no push credential at all', async () => {
    const execFn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const client = fakeClient();
    await runUninstall({ apiClient: client, execFn, env, erase: true, platform: 'linux', print: () => {} });
    expect(client.disable).not.toHaveBeenCalled();
    expect(client.eraseObservations).not.toHaveBeenCalled();
  });

  it('removes the unit file, config, and outbox - and status reports not-installed afterward', async () => {
    writePushCredential({ sensorSourceId: 's1', pushToken: 't', ingestUrl: 'u' }, env);
    writeSentinelLocalConfig(
      { deviceId: 'd1', consentVersion: 'v1', installedAt: 'x', sourcePlatform: 'linux', codexHome: { kind: 'unset' } },
      env,
    );
    appendToOutbox([outboxRow], env);
    const unitPath = systemdUnitPath(env);
    const { atomicWriteFile } = await import('./state.js');
    atomicWriteFile(unitPath, '[Unit]\n');
    expect(existsSync(unitPath)).toBe(true);

    const execFn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const client = fakeClient();
    await runUninstall({ apiClient: client, execFn, env, erase: false, platform: 'linux', print: () => {} });

    expect(existsSync(unitPath)).toBe(false);
    expect(readSentinelLocalConfig(env)).toBeUndefined();
    expect(readOutbox(env).rows).toHaveLength(0);

    const status = await runStatus({ execFn, env, platform: 'linux' });
    expect(status.installed).toBe(false);
    expect(status.unitExists).toBe(false);
  });

  it('removes the launchd plist on macOS', async () => {
    writePushCredential({ sensorSourceId: 's1', pushToken: 't', ingestUrl: 'u' }, env);
    const plistPath = launchdPlistPath(env);
    const { atomicWriteFile } = await import('./state.js');
    atomicWriteFile(plistPath, '<plist/>\n');
    expect(existsSync(plistPath)).toBe(true);

    const execFn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const client = fakeClient();
    await runUninstall({ apiClient: client, execFn, env, erase: false, platform: 'macos', print: () => {} });

    expect(existsSync(plistPath)).toBe(false);
  });
});
