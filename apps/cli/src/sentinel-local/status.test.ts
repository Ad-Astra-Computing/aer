import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStatus } from './status.js';
import { writeSentinelLocalConfig, appendToOutbox, OUTBOX_CAP } from './state.js';
import { runInstall } from './install.js';
import type { SentinelLocalApiClient } from './http-client.js';

let dir: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aer-sentinel-status-test-'));
  env = { HOME: dir };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const row = {
  observation_id: 'a'.repeat(64),
  observed_at: '2026-01-01T00:00:00Z',
  destination_evidence: 'none' as const,
  destination_family: null,
  tool: 'claude_code' as const,
  instrumentation: 'none' as const,
};

describe('runStatus', () => {
  it('reports not installed when nothing has been written yet', async () => {
    const execFn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const result = await runStatus({ execFn, env, platform: 'linux' });
    expect(result.installed).toBe(false);
    expect(result.unitExists).toBe(false);
    expect(result.daemonActive).toBe(false);
  });

  it('detects a broken/missing unit file after install state exists but the file was removed', async () => {
    writeSentinelLocalConfig(
      { deviceId: 'd1', consentVersion: 'v1', installedAt: 'x', sourcePlatform: 'linux', codexHome: { kind: 'unset' } },
      env,
    );
    const execFn = vi.fn(async () => ({ code: 0, stdout: 'active\n', stderr: '' }));
    const result = await runStatus({ execFn, env, platform: 'linux' });
    expect(result.installed).toBe(true);
    expect(result.unitExists).toBe(false);
    expect(result.daemonActive).toBe(false); // never calls systemctl for a missing unit
  });

  it('reports outbox depth and dropped count', async () => {
    appendToOutbox(Array.from({ length: OUTBOX_CAP + 5 }, () => row), env);
    const execFn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const result = await runStatus({ execFn, env, platform: 'linux' });
    expect(result.outboxDepth).toBe(OUTBOX_CAP);
    expect(result.droppedCount).toBe(5);
  });

  it('flags a CODEX_HOME mismatch between install-time and the current shell', async () => {
    const execFn = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    await runInstall({
      apiClient: {
        register: vi.fn(async () => ({ sensor_source_id: 's1', push_token: 't', ingest_url: 'u', expected_claim_id: 'c' })),
        disable: vi.fn(),
        eraseObservations: vi.fn(),
        push: vi.fn(),
      } as unknown as SentinelLocalApiClient,
      execFn,
      env: { ...env, CODEX_HOME: '/home/dev/.codex-alt' },
      platform: 'linux',
      execPath: '/usr/bin/node',
      scriptPath: '/opt/aer/main.js',
      print: () => {},
    });
    const result = await runStatus({ execFn, env: { ...env, CODEX_HOME: '/home/dev/.codex-new' }, platform: 'linux' });
    expect(result.codexHome?.stale).toBe(true);
    expect(result.codexHome?.recordedValue).toBe('/home/dev/.codex-alt');
    expect(result.codexHome?.current).toBe('/home/dev/.codex-new');
  });
});
