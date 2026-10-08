import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadState,
  saveState,
  deleteState,
  freshState,
  enqueue,
  stateRoot,
  acquireSessionLock,
  savePidAlias,
  loadPidAlias,
  MAX_OUTBOX_EVENTS,
  sweepStale,
  lockFileFor,
  type SessionState,
} from './session-store.js';

describe('session-store', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  const T = 1_000_000;
  const state = (): SessionState => ({ ...freshState(T), seq: 3, session: { id: 's1', ingestToken: 'tok', baseUrl: 'https://api.test', openedAt: T } });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aer-store-'));
    fs.mkdirSync(path.join(dir, 'tmp'));
    env = { XDG_CACHE_HOME: dir, TMPDIR: path.join(dir, 'tmp') } as NodeJS.ProcessEnv;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('round-trips save then load', () => {
    expect(saveState('hs-1', state(), env)).toBe(true);
    expect(loadState('hs-1', env, T)).toEqual(state());
  });

  it('returns null for an unknown id', () => {
    expect(loadState('nope', env, T)).toBeNull();
  });

  it('treats state untouched for a day as absent and unlinks it', () => {
    saveState('hs-2', state(), env);
    expect(loadState('hs-2', env, T + 24 * 60 * 60 * 1000 + 1)).toBeNull();
    expect(loadState('hs-2', env, T)).toBeNull();
  });

  it('measures that day from the last activity, not from when the session opened', () => {
    saveState('hs-2b', { ...state(), lastActivityAt: T + 20 * 60 * 60 * 1000 }, env);
    expect(loadState('hs-2b', env, T + 30 * 60 * 60 * 1000)).not.toBeNull();
  });

  it('writes the token file 0600 in a 0700 directory', () => {
    saveState('hs-3', state(), env);
    const files = fs.readdirSync(path.join(dir, 'aer-hooks'));
    expect(files).toHaveLength(1);
    expect(fs.statSync(path.join(dir, 'aer-hooks', files[0]!)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir, 'aer-hooks')).mode & 0o777).toBe(0o700);
  });

  it('delete removes the entry', () => {
    saveState('hs-4', state(), env);
    deleteState('hs-4', env);
    expect(loadState('hs-4', env, T)).toBeNull();
  });

  it('carries on a session an earlier release stored, rather than reopening it', () => {
    fs.mkdirSync(path.join(dir, 'aer-hooks'), { recursive: true });
    saveState('hs-legacy', state(), env);
    const file = path.join(dir, 'aer-hooks', fs.readdirSync(path.join(dir, 'aer-hooks'))[0]!);
    fs.writeFileSync(file, JSON.stringify({ aerSessionId: 'old-1', ingestToken: 'old-tok', baseUrl: 'https://api.test', createdAt: T, seq: 7, toolsOpen: 1, transcriptPath: '/t', transcriptOffset: 99, emittedLlmMessageIds: ['m1'] }));
    const loaded = loadState('hs-legacy', env, T + 1)!;
    expect(loaded.session).toEqual({ id: 'old-1', ingestToken: 'old-tok', baseUrl: 'https://api.test', openedAt: T });
    expect(loaded.seq).toBe(7);
    expect(loaded.toolsOpen).toBe(1);
    expect(loaded.transcriptOffset).toBe(99);
    expect(loaded.emittedLlmMessageIds).toEqual(['m1']);
    expect(loaded.outbox).toEqual([]);
  });

  it('reads an earlier release\'s opening marker as nothing open yet', () => {
    saveState('hs-pending', state(), env);
    const file = path.join(dir, 'aer-hooks', fs.readdirSync(path.join(dir, 'aer-hooks'))[0]!);
    fs.writeFileSync(file, JSON.stringify({ pending: true, clientRef: 'v1:abc', createdAt: T }));
    const loaded = loadState('hs-pending', env, T + 1)!;
    expect(loaded.session).toBeUndefined();
    expect(loaded.seq).toBe(0);
  });

  it('keeps at most the queue cap, dropping and counting the oldest', () => {
    const st = freshState(T);
    const ev = (i: number) => ({ id: `e${i}`, type: 'tool.started', ts: 'x', payload: { i } });
    expect(enqueue(st, Array.from({ length: MAX_OUTBOX_EVENTS }, (_, i) => ev(i)))).toBe(0);
    expect(enqueue(st, [ev(-1), ev(-2)])).toBe(2);
    expect(st.outbox).toHaveLength(MAX_OUTBOX_EVENTS);
    expect(st.outbox[0]!.id).toBe('e2');
    expect(st.droppedBudget).toBe(2);
  });

  it('falls back to a private directory under the temp dir when the cache cannot be written', () => {
    const blocker = path.join(dir, 'file-not-dir');
    fs.writeFileSync(blocker, 'x');
    const bad = { XDG_CACHE_HOME: blocker, TMPDIR: path.join(dir, 'tmp') } as NodeJS.ProcessEnv;
    expect(saveState('x', state(), bad)).toBe(true);
    const root = stateRoot(bad)!;
    expect(path.dirname(root)).toBe(path.join(dir, 'tmp'));
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(loadState('x', bad, T)?.session?.id).toBe('s1');
  });

  it('refuses a directory planted as a link, anywhere in the chain, and never writes through it', () => {
    const real = path.join(dir, 'real-cache');
    fs.mkdirSync(real);
    const xdg = path.join(dir, 'xdg');
    fs.mkdirSync(xdg);
    fs.symlinkSync(real, path.join(xdg, 'aer-hooks'));
    const tmp = path.join(dir, 'tmp2');
    fs.mkdirSync(tmp);
    const uid = typeof process.getuid === 'function' ? String(process.getuid()) : os.userInfo().username;
    fs.symlinkSync(real, path.join(tmp, `aer-hooks-${uid}`));
    const env2 = { XDG_CACHE_HOME: xdg, TMPDIR: tmp } as NodeJS.ProcessEnv;
    expect(() => saveState('hs', state(), env2)).not.toThrow();
    expect(saveState('hs', state(), env2)).toBe(false);
    expect(fs.readdirSync(real)).toHaveLength(0);
  });

  it('sweeps state left by sessions that never came back, bounded per pass', () => {
    saveState('live', { ...state(), lastActivityAt: Date.now() }, env);
    const root = path.join(dir, 'aer-hooks');
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const names = [
      ...Array.from({ length: 240 }, (_, i) => `${String(i).padStart(32, '0')}.json`),
      'drop-abc.json', 'pid-123.json', 'x.json.99.tmp', 'y.json.lock',
    ];
    for (const n of names) {
      fs.writeFileSync(path.join(root, n), '{}');
      fs.utimesSync(path.join(root, n), old, old);
    }
    fs.mkdirSync(path.join(root, 'old-dir'));
    fs.utimesSync(path.join(root, 'old-dir'), old, old);
    const outside = path.join(dir, 'outside.json');
    fs.writeFileSync(outside, '{}');
    fs.symlinkSync(outside, path.join(root, 'link.json'));

    expect(sweepStale(env)).toBe(200);
    expect(sweepStale(env)).toBe(names.length - 200);
    expect(sweepStale(env)).toBe(0);
    const left = fs.readdirSync(root).sort();
    expect(left).toContain('old-dir');
    expect(left).toContain('link.json');
    expect(fs.existsSync(outside)).toBe(true);
    expect(loadState('live', env)?.session?.id).toBe('s1');
  });

  it('never throws when nowhere can be written', () => {
    const blocker = path.join(dir, 'file-not-dir');
    fs.writeFileSync(blocker, 'x');
    const none = { XDG_CACHE_HOME: blocker, TMPDIR: blocker } as NodeJS.ProcessEnv;
    expect(stateRoot(none)).toBeNull();
    expect(saveState('x', state(), none)).toBe(false);
    expect(loadState('x', none, T)).toBeNull();
  });

  // The TOCTOU race this guards against: two concurrent hook processes both call
  // loadState(), both see null, and both open a new AER session for the same
  // harness session id. The lock forces one to wait for the other and re-check.
  describe('acquireSessionLock', () => {
    it('acquires immediately when uncontended, and release lets a later caller acquire', async () => {
      const lock1 = await acquireSessionLock('hs-lock-1', env);
      expect(lock1).not.toBeNull();
      lock1!.release();

      const lock2 = await acquireSessionLock('hs-lock-1', env);
      expect(lock2).not.toBeNull();
      lock2!.release();
    });

    it('a concurrent caller waits for the holder to release, then acquires', async () => {
      const lock1 = await acquireSessionLock('hs-lock-2', env);
      expect(lock1).not.toBeNull();

      const waiter = acquireSessionLock('hs-lock-2', env, { maxWaitMs: 2000, pollMs: 10 });
      await new Promise((r) => setTimeout(r, 50));
      lock1!.release();

      const lock2 = await waiter;
      expect(lock2).not.toBeNull();
      lock2!.release();
    });

    it('gives up and returns null after maxWaitMs when the lock is never released', async () => {
      const lock1 = await acquireSessionLock('hs-lock-3', env);
      expect(lock1).not.toBeNull();

      const lock2 = await acquireSessionLock('hs-lock-3', env, { maxWaitMs: 60, pollMs: 10 });
      expect(lock2).toBeNull();

      lock1!.release();
    });

    it('steals a lock left by a crashed holder once it is older than staleMs', async () => {
      const lock1 = await acquireSessionLock('hs-lock-4', env);
      expect(lock1).not.toBeNull();

      // Simulate a crashed holder: back-date the lock file well past staleMs
      // instead of releasing it.
      const lockFileName = fs.readdirSync(path.join(dir, 'aer-hooks')).find((f) => f.endsWith('.lock'));
      expect(lockFileName).toBeDefined();
      const lockPath = path.join(dir, 'aer-hooks', lockFileName!);
      const old = new Date(Date.now() - 10_000);
      fs.utimesSync(lockPath, old, old);

      const lock2 = await acquireSessionLock('hs-lock-4', env, { staleMs: 1000, maxWaitMs: 2000, pollMs: 10 });
      expect(lock2).not.toBeNull();
      lock2!.release();
    });

    it('never takes over a lock a live holder made after the stale one was judged stale', async () => {
      const lockFile = lockFileFor('hs-lock-race', env)!;
      fs.writeFileSync(lockFile, 'dead-holder');
      const old = new Date(Date.now() - 10_000);
      fs.utimesSync(lockFile, old, old);
      // Another waiter took the stale lock over and a live holder now has it.
      const lock2 = await acquireSessionLock('hs-lock-race', env, {
        staleMs: 1000, maxWaitMs: 150, pollMs: 10,
        beforeTakeover: () => { fs.unlinkSync(lockFile); fs.writeFileSync(lockFile, 'live-holder'); },
      });
      expect(lock2).toBeNull();
      expect(fs.readFileSync(lockFile, 'utf8')).toBe('live-holder');
    });

    it('degrades to null (never throws) when nowhere can be written', async () => {
      const blocker = path.join(dir, 'blocker-file');
      fs.writeFileSync(blocker, 'x');
      const badEnv = { XDG_CACHE_HOME: path.join(blocker, 'nope'), TMPDIR: blocker } as NodeJS.ProcessEnv;
      await expect(acquireSessionLock('hs-lock-5', badEnv)).resolves.toBeNull();
    });

    it('two truly concurrent acquisitions for the same id never both succeed', async () => {
      const results = await Promise.all([
        acquireSessionLock('hs-lock-6', env, { maxWaitMs: 100, pollMs: 5 }),
        acquireSessionLock('hs-lock-6', env, { maxWaitMs: 100, pollMs: 5 }),
      ]);
      const acquired = results.filter((r) => r !== null);
      expect(acquired).toHaveLength(1);
      acquired[0]!.release();
    });
  });

  // Review P2: pid recycling and identity across agents/tenants.
  describe('pid alias identity guard', () => {
    it('round-trips with no identity check', () => {
      savePidAlias('123', 'store-key-1', env, 1000);
      expect(loadPidAlias('123', env, 2000)).toBe('store-key-1');
    });

    it('refuses an alias whose recorded process start time does not match (a recycled pid)', () => {
      savePidAlias('123', 'store-key-1', env, 1000, { startTime: '1111' });
      expect(loadPidAlias('123', env, 2000, { startTime: '1111' })).toBe('store-key-1');
      expect(loadPidAlias('123', env, 2000, { startTime: '9999' })).toBeNull();
    });

    it('refuses an alias written for a different agent', () => {
      savePidAlias('123', 'store-key-1', env, 1000, { agentId: 'agent-a' });
      expect(loadPidAlias('123', env, 2000, { agentId: 'agent-a' })).toBe('store-key-1');
      expect(loadPidAlias('123', env, 2000, { agentId: 'agent-b' })).toBeNull();
    });

    it('refuses an alias written for a different base URL (a different tenant/deployment)', () => {
      savePidAlias('123', 'store-key-1', env, 1000, { baseUrl: 'https://a.test' });
      expect(loadPidAlias('123', env, 2000, { baseUrl: 'https://a.test' })).toBe('store-key-1');
      expect(loadPidAlias('123', env, 2000, { baseUrl: 'https://b.test' })).toBeNull();
    });

    it('does not refuse an older alias that carries no identity at all', () => {
      // Written before this fix shipped: no startTime/agentId/baseUrl fields.
      saveRawPidAlias(dir, '123', { ref: 'store-key-1', createdAt: 1000 });
      expect(loadPidAlias('123', env, 2000, { startTime: 'anything', agentId: 'agent-a' })).toBe('store-key-1');
    });
  });
});

function saveRawPidAlias(dir: string, pid: string, data: Record<string, unknown>): void {
  const sub = path.join(dir, 'aer-hooks');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, `pid-${pid}.json`), JSON.stringify(data));
}

describe('the queue cap', () => {
  it('never drops the closing report to make room', () => {
    const st = freshState(1);
    const closing = { id: 'end', type: 'collector.report', ts: 'x', payload: { phase: 'session_end' } };
    const ev = (i: number) => ({ id: `e${i}`, type: 'tool.started', ts: 'x', payload: { i } });
    enqueue(st, [closing]);
    enqueue(st, Array.from({ length: MAX_OUTBOX_EVENTS + 5 }, (_, i) => ev(i)));
    expect(st.outbox).toHaveLength(MAX_OUTBOX_EVENTS);
    expect(st.outbox[0]!.id).toBe('end');
    expect(st.droppedBudget).toBe(6);
  });
});

// Oversight markers (P0-1): openCalls/pendingApprovals/approvalsUnresolved
// pass through the same parseState shape validation as every other field
// (Fable's re-review item 6), each capped at MAX_APPROVAL_TRACKING_ENTRIES.
describe('oversight-marker correlation state', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  const T = 2_000_000;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aer-store-ovm-'));
    fs.mkdirSync(path.join(dir, 'tmp'));
    env = { XDG_CACHE_HOME: dir, TMPDIR: path.join(dir, 'tmp') } as NodeJS.ProcessEnv;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('defaults approvalsUnresolved to 0 on a fresh state', () => {
    expect(freshState(T).approvalsUnresolved).toBe(0);
  });

  it('round-trips openCalls, pendingApprovals and approvalsUnresolved', () => {
    const st: SessionState = {
      ...freshState(T),
      openCalls: { toolu_1: { callDigest: 'a'.repeat(32), openedAt: T } },
      pendingApprovals: [{ id: 'toolu_0', pushedAt: T }, { id: 'unid:1', pushedAt: T + 1 }],
      pendingApprovalSeq: 1,
      approvalsUnresolved: 3,
    };
    saveState('ovm-1', st, env);
    const loaded = loadState('ovm-1', env, T)!;
    expect(loaded.openCalls).toEqual({ toolu_1: { callDigest: 'a'.repeat(32), openedAt: T } });
    expect(loaded.pendingApprovals).toEqual([{ id: 'toolu_0', pushedAt: T }, { id: 'unid:1', pushedAt: T + 1 }]);
    expect(loaded.pendingApprovalSeq).toBe(1);
    expect(loaded.approvalsUnresolved).toBe(3);
  });

  it('drops a malformed openCalls entry (bad digest shape) rather than keeping it', () => {
    fs.mkdirSync(path.join(dir, 'aer-hooks'), { recursive: true });
    saveState('ovm-bad', freshState(T), env);
    const file = path.join(dir, 'aer-hooks', fs.readdirSync(path.join(dir, 'aer-hooks'))[0]!);
    fs.writeFileSync(file, JSON.stringify({
      v: 2, createdAt: T, lastActivityAt: T, seq: 0, droppedBudget: 0, approvalsUnresolved: 0, outbox: [],
      openCalls: { toolu_1: { callDigest: 'not-hex', openedAt: T }, toolu_2: { callDigest: 'b'.repeat(32), openedAt: T } },
    }));
    const loaded = loadState('ovm-bad', env, T)!;
    expect(loaded.openCalls).toEqual({ toolu_2: { callDigest: 'b'.repeat(32), openedAt: T } });
  });

  it('drops a malformed pendingApprovals entry rather than keeping it', () => {
    fs.mkdirSync(path.join(dir, 'aer-hooks'), { recursive: true });
    saveState('ovm-bad2', freshState(T), env);
    const file = path.join(dir, 'aer-hooks', fs.readdirSync(path.join(dir, 'aer-hooks'))[0]!);
    fs.writeFileSync(file, JSON.stringify({
      v: 2, createdAt: T, lastActivityAt: T, seq: 0, droppedBudget: 0, approvalsUnresolved: 0, outbox: [],
      pendingApprovals: [
        { id: 'toolu_1', pushedAt: T },
        { id: 42, pushedAt: T },
        null,
        { id: 'unid:2', pushedAt: 'not-a-number' },
        { id: 'unid:3', pushedAt: T + 1 },
      ],
    }));
    const loaded = loadState('ovm-bad2', env, T)!;
    expect(loaded.pendingApprovals).toEqual([{ id: 'toolu_1', pushedAt: T }, { id: 'unid:3', pushedAt: T + 1 }]);
  });

  it('caps openCalls at MAX_APPROVAL_TRACKING_ENTRIES, keeping the most recently opened', () => {
    fs.mkdirSync(path.join(dir, 'aer-hooks'), { recursive: true });
    saveState('ovm-cap', freshState(T), env);
    const file = path.join(dir, 'aer-hooks', fs.readdirSync(path.join(dir, 'aer-hooks'))[0]!);
    const openCalls: Record<string, { callDigest: string; openedAt: number }> = {};
    for (let i = 0; i < 70; i++) openCalls[`toolu_${i}`] = { callDigest: 'c'.repeat(32), openedAt: T + i };
    fs.writeFileSync(file, JSON.stringify({
      v: 2, createdAt: T, lastActivityAt: T, seq: 0, droppedBudget: 0, approvalsUnresolved: 0, outbox: [], openCalls,
    }));
    const loaded = loadState('ovm-cap', env, T)!;
    expect(Object.keys(loaded.openCalls ?? {})).toHaveLength(64);
    // The oldest (lowest openedAt) are the ones dropped.
    expect(loaded.openCalls?.['toolu_0']).toBeUndefined();
    expect(loaded.openCalls?.['toolu_69']).toBeDefined();
  });

  it('caps pendingApprovals at MAX_APPROVAL_TRACKING_ENTRIES, keeping the newest (oldest-first order)', () => {
    fs.mkdirSync(path.join(dir, 'aer-hooks'), { recursive: true });
    saveState('ovm-cap2', freshState(T), env);
    const file = path.join(dir, 'aer-hooks', fs.readdirSync(path.join(dir, 'aer-hooks'))[0]!);
    const pendingApprovals = Array.from({ length: 70 }, (_, i) => ({ id: `toolu_${i}`, pushedAt: T + i }));
    fs.writeFileSync(file, JSON.stringify({
      v: 2, createdAt: T, lastActivityAt: T, seq: 0, droppedBudget: 0, approvalsUnresolved: 0, outbox: [], pendingApprovals,
    }));
    const loaded = loadState('ovm-cap2', env, T)!;
    expect(loaded.pendingApprovals).toHaveLength(64);
    expect(loaded.pendingApprovals?.map((e) => e.id)).not.toContain('toolu_0');
    expect(loaded.pendingApprovals?.map((e) => e.id)).toContain('toolu_69');
  });

  it('defaults approvalsUnresolved to 0 when the stored value is missing or invalid', () => {
    fs.mkdirSync(path.join(dir, 'aer-hooks'), { recursive: true });
    saveState('ovm-neg', freshState(T), env);
    const file = path.join(dir, 'aer-hooks', fs.readdirSync(path.join(dir, 'aer-hooks'))[0]!);
    fs.writeFileSync(file, JSON.stringify({ v: 2, createdAt: T, lastActivityAt: T, seq: 0, droppedBudget: 0, approvalsUnresolved: -1, outbox: [] }));
    const loaded = loadState('ovm-neg', env, T)!;
    expect(loaded.approvalsUnresolved).toBe(0);
  });
});
