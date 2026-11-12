import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDaemonTick, initialDaemonState } from './daemon.js';
import { readOutbox } from './state.js';
import type { SentinelLocalApiClient } from './http-client.js';

let dir: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aer-sentinel-daemon-test-'));
  env = { HOME: dir };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const KEY = Buffer.from('b'.repeat(64), 'hex');

function makeClient(pushImpl: SentinelLocalApiClient['push']): SentinelLocalApiClient {
  return {
    register: vi.fn(),
    disable: vi.fn(),
    eraseObservations: vi.fn(),
    getSensors: vi.fn(async () => []),
    push: pushImpl,
  };
}

describe('runDaemonTick', () => {
  it('appends new rows to the outbox and pushes immediately on first data', async () => {
    const push = vi.fn(async () => ({ status: 200, ok: true, retryable: false }));
    const client = makeClient(push);
    const candidate = { tool: 'claude_code' as const, sockets: [{ localAddress: '10.0.0.1', localPort: 1, remoteAddress: '160.79.104.1', remotePort: 443 }] };
    const state = await runDaemonTick(initialDaemonState(), {
      perInstallKey: KEY,
      sensorSourceId: 's1',
      pushToken: 'tok',
      apiClient: client,
      enumerate: async () => [candidate],
      env,
    });
    expect(push).toHaveBeenCalledTimes(1);
    expect(readOutbox(env).rows).toHaveLength(0); // pushed successfully, outbox drained
    expect(state.backoffMs).toBe(0);
  });

  it('never pushes when there is no new data', async () => {
    const push = vi.fn(async () => ({ status: 200, ok: true, retryable: false }));
    const client = makeClient(push);
    await runDaemonTick(initialDaemonState(), {
      perInstallKey: KEY,
      sensorSourceId: 's1',
      pushToken: 'tok',
      apiClient: client,
      enumerate: async () => [],
      env,
    });
    expect(push).not.toHaveBeenCalled();
  });

  it('backs off exponentially on a 429 and keeps the rows queued', async () => {
    const push = vi.fn(async () => ({ status: 429, ok: false, retryable: true }));
    const client = makeClient(push);
    const candidate = { tool: 'claude_code' as const, sockets: [{ localAddress: '10.0.0.1', localPort: 1, remoteAddress: '160.79.104.1', remotePort: 443 }] };
    const state = await runDaemonTick(initialDaemonState(), {
      perInstallKey: KEY,
      sensorSourceId: 's1',
      pushToken: 'tok',
      apiClient: client,
      enumerate: async () => [candidate],
      env,
    });
    expect(state.backoffMs).toBeGreaterThan(0);
    expect(readOutbox(env).rows).toHaveLength(1); // not drained: push failed
  });

  it('drops the whole batch on a 400 (malformed envelope) instead of retrying forever (H1)', async () => {
    const push = vi.fn(async () => ({ status: 400, ok: false, retryable: false }));
    const client = makeClient(push);
    const candidate = { tool: 'claude_code' as const, sockets: [{ localAddress: '10.0.0.1', localPort: 1, remoteAddress: '160.79.104.1', remotePort: 443 }] };
    const state = await runDaemonTick(initialDaemonState(), {
      perInstallKey: KEY, sensorSourceId: 's1', pushToken: 'tok', apiClient: client,
      enumerate: async () => [candidate], env,
    });
    expect(readOutbox(env).rows).toHaveLength(0);
    expect(readOutbox(env).droppedCount).toBe(1);
    expect(state.halted).toBeUndefined();
  });

  it('halts on a 401/403 and stops attempting further pushes (H1)', async () => {
    const push = vi.fn(async () => ({ status: 403, ok: false, retryable: false }));
    const client = makeClient(push);
    const candidate = { tool: 'claude_code' as const, sockets: [{ localAddress: '10.0.0.1', localPort: 1, remoteAddress: '160.79.104.1', remotePort: 443 }] };
    let state = await runDaemonTick(initialDaemonState(), {
      perInstallKey: KEY, sensorSourceId: 's1', pushToken: 'tok', apiClient: client,
      enumerate: async () => [candidate], env,
    });
    expect(state.halted).toBeDefined();
    expect(readOutbox(env).rows).toHaveLength(1); // left queued, never dropped

    // A second tick, even with cadence/backoff satisfied, never calls push again.
    push.mockClear();
    state = await runDaemonTick(state, {
      perInstallKey: KEY, sensorSourceId: 's1', pushToken: 'tok', apiClient: client,
      enumerate: async () => [], env, now: () => new Date(10 * 60_000),
    });
    expect(push).not.toHaveBeenCalled();
  });

  it('respects the push cadence: does not push again before the interval elapses', async () => {
    const push = vi.fn(async () => ({ status: 200, ok: true, retryable: false }));
    const client = makeClient(push);
    const candidate1 = { tool: 'claude_code' as const, sockets: [{ localAddress: '10.0.0.1', localPort: 1, remoteAddress: '160.79.104.1', remotePort: 443 }] };
    const candidate2 = { tool: 'claude_code' as const, sockets: [{ localAddress: '10.0.0.1', localPort: 2, remoteAddress: '160.79.104.2', remotePort: 443 }] };
    let t = 0;
    const now = () => new Date(t);
    let state = initialDaemonState();
    state = await runDaemonTick(state, { perInstallKey: KEY, sensorSourceId: 's1', pushToken: 'tok', apiClient: client, enumerate: async () => [candidate1], env, now });
    t += 1000; // 1s later: well within the 60s push cadence
    state = await runDaemonTick(state, { perInstallKey: KEY, sensorSourceId: 's1', pushToken: 'tok', apiClient: client, enumerate: async () => [candidate2], env, now });
    expect(push).toHaveBeenCalledTimes(1);
    expect(readOutbox(env).rows).toHaveLength(1); // candidate2's row queued, not yet pushed
  });
});
