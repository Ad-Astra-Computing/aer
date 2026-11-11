import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureDeviceId,
  deviceIdPath,
  writeSentinelLocalConfig,
  readSentinelLocalConfig,
  writePushCredential,
  readPushCredential,
  deletePushCredential,
  pushCredentialPath,
  appendToOutbox,
  readOutbox,
  removeFromOutboxFront,
  OUTBOX_CAP,
  StateSymlinkError,
  atomicWriteFile,
} from './state.js';

let dir: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aer-sentinel-state-test-'));
  env = { HOME: dir, XDG_CONFIG_HOME: undefined };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ensureDeviceId', () => {
  it('mints a device id on first call, mode 0600', () => {
    const id = ensureDeviceId(env);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const mode = statSync(deviceIdPath(env)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('returns the same id on a second call', () => {
    const a = ensureDeviceId(env);
    const b = ensureDeviceId(env);
    expect(a).toBe(b);
  });
});

describe('sentinel-local.json', () => {
  it('round-trips', () => {
    writeSentinelLocalConfig(
      {
        deviceId: 'd1',
        consentVersion: 'v1',
        installedAt: '2026-01-01T00:00:00Z',
        sourcePlatform: 'linux',
        codexHome: { kind: 'unset' },
      },
      env,
    );
    const read = readSentinelLocalConfig(env);
    expect(read?.deviceId).toBe('d1');
    expect(read?.codexHome).toEqual({ kind: 'unset' });
  });
});

describe('push credential', () => {
  it('writes, reads, and deletes', () => {
    writePushCredential({ sensorSourceId: 's1', pushToken: 't1', ingestUrl: 'https://x/y', expectedClaimId: 'c1' }, env);
    expect(readPushCredential(env)?.sensorSourceId).toBe('s1');
    deletePushCredential(env);
    expect(readPushCredential(env)).toBeUndefined();
  });

  it('deletePushCredential is a no-op when nothing exists', () => {
    expect(() => deletePushCredential(env)).not.toThrow();
  });
});

describe('outbox', () => {
  const row = (id: string) => ({
    observation_id: id.padEnd(64, '0'),
    observed_at: '2026-01-01T00:00:00Z',
    destination_evidence: 'none' as const,
    destination_family: null,
    tool: 'claude_code' as const,
    instrumentation: 'none' as const,
  });

  it('appends and reads back rows', () => {
    appendToOutbox([row('a')], env);
    const outbox = readOutbox(env);
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.droppedCount).toBe(0);
  });

  it('drops the oldest entries past the cap and counts them', () => {
    const rows = Array.from({ length: OUTBOX_CAP + 10 }, (_, i) => row(`r${i}`));
    const outbox = appendToOutbox(rows, env);
    expect(outbox.rows).toHaveLength(OUTBOX_CAP);
    expect(outbox.droppedCount).toBe(10);
    // the oldest 10 are gone; the newest survive
    expect(outbox.rows[0]!.observation_id).toBe(rows[10]!.observation_id);
  });

  it('removeFromOutboxFront removes successfully-pushed entries', () => {
    appendToOutbox([row('a'), row('b'), row('c')], env);
    const after = removeFromOutboxFront(2, env);
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]!.observation_id).toBe(row('c').observation_id);
  });
});

describe('symlink refusal', () => {
  it('refuses to write through a symlinked target file', () => {
    const real = join(dir, 'real-target');
    const link = join(dir, 'linked.json');
    writeFileSync(real, 'x');
    symlinkSync(real, link);
    expect(() => atomicWriteFile(link, 'y')).toThrow(StateSymlinkError);
  });
});
