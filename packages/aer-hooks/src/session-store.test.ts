import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadSession, saveSession, deleteSession, acquireSessionLock, type StoredSession } from './session-store.js';

describe('session-store', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  const entry: StoredSession = { aerSessionId: 's1', ingestToken: 'tok', baseUrl: 'https://api.test', createdAt: 1000 };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aer-store-'));
    env = { XDG_CACHE_HOME: dir } as NodeJS.ProcessEnv;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('round-trips save then load', () => {
    saveSession('hs-1', entry, env);
    expect(loadSession('hs-1', env, 1000)).toEqual(entry);
  });

  it('returns null for an unknown id', () => {
    expect(loadSession('nope', env, 1000)).toBeNull();
  });

  it('treats an entry past the TTL as absent and unlinks it', () => {
    saveSession('hs-2', entry, env);
    // 24h + 1ms later
    expect(loadSession('hs-2', env, 1000 + 24 * 60 * 60 * 1000 + 1)).toBeNull();
    // and a fresh read still sees nothing (file removed)
    expect(loadSession('hs-2', env, 1000)).toBeNull();
  });

  it('writes the token file 0600', () => {
    saveSession('hs-3', entry, env);
    const files = fs.readdirSync(path.join(dir, 'aer-hooks'));
    expect(files).toHaveLength(1);
    const mode = fs.statSync(path.join(dir, 'aer-hooks', files[0]!)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('delete removes the entry', () => {
    saveSession('hs-4', entry, env);
    deleteSession('hs-4', env);
    expect(loadSession('hs-4', env, 1000)).toBeNull();
  });

  it('never throws on a bad cache path', () => {
    const bad = { XDG_CACHE_HOME: path.join(dir, 'file-not-dir') } as NodeJS.ProcessEnv;
    fs.writeFileSync(path.join(dir, 'file-not-dir'), 'x');
    expect(() => saveSession('x', entry, bad)).not.toThrow();
    expect(loadSession('x', bad, 1000)).toBeNull();
  });

  it('degrades (writes nothing) when the cache dir is a symlink', () => {
    const real = path.join(dir, 'real-cache');
    fs.mkdirSync(real);
    // XDG_CACHE_HOME/aer-hooks will be a symlink to `real`.
    const xdg = path.join(dir, 'xdg');
    fs.mkdirSync(xdg);
    fs.symlinkSync(real, path.join(xdg, 'aer-hooks'));
    const env2 = { XDG_CACHE_HOME: xdg } as NodeJS.ProcessEnv;
    expect(() => saveSession('hs', entry, env2)).not.toThrow();
    // Nothing was written through the symlink.
    expect(fs.readdirSync(real)).toHaveLength(0);
  });

  // The TOCTOU race this guards against: two concurrent hook processes both call
  // loadSession(), both see null, and both open a new AER session for the same
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

    it('degrades to null (never throws) on an unwritable cache dir', async () => {
      const blocker = path.join(dir, 'blocker-file');
      fs.writeFileSync(blocker, 'x');
      const badEnv = { XDG_CACHE_HOME: path.join(blocker, 'nope') } as NodeJS.ProcessEnv;
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
});
