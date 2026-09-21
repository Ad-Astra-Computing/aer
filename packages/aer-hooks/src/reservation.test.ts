// Two failures a reviewer found in the session store, both of which turn a
// partial record into a wrong one.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSessionLock, saveSession, loadSession } from './session-store.js';
import { plannedEventCount } from './cli.js';

let cache: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => { cache = mkdtempSync(join(tmpdir(), 'aer-resv-')); env = { XDG_CACHE_HOME: cache }; });
afterEach(() => { rmSync(cache, { recursive: true, force: true }); });

describe('plannedEventCount', () => {
  it('knows how many events an invocation will produce, before it produces them', () => {
    // The position has to be reserved before the network call, so it cannot
    // be counted after it.
    expect(plannedEventCount({ kind: 'tool_start', tool: 'Bash' })).toBe(1);
    expect(plannedEventCount({ kind: 'tool_start', tool: 'Bash', shape: { eventType: 'process.exec', payload: {} } })).toBe(2);
    expect(plannedEventCount({ kind: 'tool_start' })).toBe(1);
    expect(plannedEventCount({ kind: 'tool_end', tool: 'Bash' })).toBe(1);
    expect(plannedEventCount({ kind: 'session_start' })).toBe(1);
    expect(plannedEventCount({ kind: 'other' })).toBe(0);
  });
});

describe('a lock is released only by the process that holds it', () => {
  it('does not unlink a lock another holder took after a steal', async () => {
    // A lock older than 5s is stolen. The original holder then finishes and
    // its release() used to unlink the NEW holder's file, letting a third in
    // while the second was still working. The clock is offset from the real
    // one so the file mtimes it is compared against stay meaningful.
    const base = Date.now();
    const first = await acquireSessionLock('s', env);
    expect(first).not.toBeNull();

    const second = await acquireSessionLock('s', env, { now: () => base + 6000, maxWaitMs: 500 });
    expect(second, 'the stale lock was not stolen').not.toBeNull();

    first!.release();

    const third = await acquireSessionLock('s', env, { maxWaitMs: 150 });
    expect(third, 'a third holder got in while the second still held the lock').toBeNull();
    second!.release();
  });

  it('still lets the next caller in after a clean release', async () => {
    const first = await acquireSessionLock('s2', env);
    first!.release();
    const second = await acquireSessionLock('s2', env, { maxWaitMs: 500 });
    expect(second).not.toBeNull();
    second!.release();
  });
});

describe('the stored position survives a lost process', () => {
  it('records the reservation before the events go out, not after', () => {
    // If the position is only written after a successful send, a hook that
    // is killed mid-request leaves the next one reusing its numbers.
    saveSession('s3', { aerSessionId: 'a', ingestToken: 't', baseUrl: 'u', createdAt: 1, seq: 4 }, env);
    const stored = loadSession('s3', env, 2);
    expect(stored?.seq).toBe(4);
  });
});

describe('a completion that fails keeps the way back to the session', () => {
  it('does not drop the stored session until the record is closed', async () => {
    // Dropping it first meant a killed or failed complete took the ingest
    // token with it: the session stayed open forever and no record was ever
    // produced. Codex kills SessionEnd at 3s, so this is not rare.
    const { runHook } = await import('./cli.js');
    saveSession('dead-1', { aerSessionId: 'a1', ingestToken: 't1', baseUrl: 'http://127.0.0.1:9', createdAt: Date.now(), seq: 5 }, env);

    await runHook(['--harness', 'claude-code', '--lifecycle', 'v2'], {
      ...env,
      AER_BASE_URL: 'http://127.0.0.1:9',
      AER_API_KEY: 'k',
      AER_TENANT_ID: '01950000-0000-7000-8000-0000000000aa',
      AER_AGENT_ID: '01950000-0000-7000-8000-0000000000ac',
      AER_HOOK_TIMEOUT_MS: '2000',
    }, {
      readInput: async () => JSON.stringify({ session_id: 'dead-1', hook_event_name: 'SessionEnd', reason: 'other' }),
    });

    // The endpoint refuses at once, so the completion failed. The entry must
    // still be there for a later attempt or for an operator to see.
    expect(loadSession('dead-1', env, Date.now())).not.toBeNull();
  }, 20_000);
});
