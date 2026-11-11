import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUninstall } from './uninstall.js';
import { writePushCredential, readPushCredential } from './state.js';
import type { SentinelLocalApiClient } from './http-client.js';

let dir: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aer-sentinel-uninstall-test-'));
  env = { HOME: dir };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeClient(): SentinelLocalApiClient {
  return { register: vi.fn(), disable: vi.fn(), eraseObservations: vi.fn(), push: vi.fn() };
}

describe('runUninstall', () => {
  it('deletes the push credential but never the device id', async () => {
    writePushCredential({ sensorSourceId: 's1', pushToken: 't', ingestUrl: 'u', expectedClaimId: 'c1' }, env);
    const execFn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const client = fakeClient();
    await runUninstall({ apiClient: client, execFn, env, erase: false, platform: 'linux', print: () => {} });
    expect(readPushCredential(env)).toBeUndefined();
    expect(client.disable).toHaveBeenCalledWith('s1');
    expect(client.eraseObservations).not.toHaveBeenCalled();
  });

  it('erases observations when --erase is requested, using the captured claim id', async () => {
    writePushCredential({ sensorSourceId: 's1', pushToken: 't', ingestUrl: 'u', expectedClaimId: 'claim-xyz' }, env);
    const execFn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const client = fakeClient();
    await runUninstall({ apiClient: client, execFn, env, erase: true, platform: 'linux', print: () => {} });
    expect(client.eraseObservations).toHaveBeenCalledWith('s1', 'claim-xyz');
  });

  it('tolerates a missing/broken unit without failing the rest of uninstall', async () => {
    writePushCredential({ sensorSourceId: 's1', pushToken: 't', ingestUrl: 'u' }, env);
    const execFn = vi.fn(async () => { throw new Error('no such unit'); });
    const client = fakeClient();
    await expect(runUninstall({ apiClient: client, execFn, env, erase: false, platform: 'linux', print: () => {} })).resolves.toBeUndefined();
    expect(client.disable).toHaveBeenCalled();
  });

  it('is a no-op server-side when there is no push credential at all', async () => {
    const execFn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const client = fakeClient();
    await runUninstall({ apiClient: client, execFn, env, erase: true, platform: 'linux', print: () => {} });
    expect(client.disable).not.toHaveBeenCalled();
    expect(client.eraseObservations).not.toHaveBeenCalled();
  });
});
