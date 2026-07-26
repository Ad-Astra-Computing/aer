// Cross-process session correlation for hooks.
//
// A harness fires the hook once per event as a SEPARATE process, so the AER
// session opened by the first invocation must be found by the next ones. We map
// the harness session id to the opened AER session in a small per-user file.
//
// The file holds an ingest token, so it is written 0600 under the user cache
// dir and deleted when the harness session ends. Entries older than the TTL are
// treated as absent (a crashed harness never cleaned up) and unlinked.
//
// Every operation is best-effort: any failure degrades (returns null / does
// nothing) and never throws, so a broken cache can never break the harness.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface StoredSession {
  aerSessionId: string;
  ingestToken: string;
  baseUrl: string;
  createdAt: number;
}

const TTL_MS = 24 * 60 * 60 * 1000; // 24h; a stale entry means a crashed harness

/** Cache dir root, honoring XDG_CACHE_HOME, else ~/.cache. */
function cacheRoot(env: NodeJS.ProcessEnv): string {
  const xdg = env['XDG_CACHE_HOME'];
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), '.cache');
  return path.join(base, 'aer-hooks');
}

function fileFor(env: NodeJS.ProcessEnv, harnessSessionId: string): string {
  const digest = createHash('sha256').update(harnessSessionId).digest('hex').slice(0, 32);
  return path.join(cacheRoot(env), `${digest}.json`);
}

/** Look up the AER session for a harness session id, or null. Best-effort. */
export function loadSession(
  harnessSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): StoredSession | null {
  try {
    const file = fileFor(env, harnessSessionId);
    const text = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(text) as Partial<StoredSession>;
    if (
      typeof parsed.aerSessionId !== 'string' ||
      typeof parsed.ingestToken !== 'string' ||
      typeof parsed.baseUrl !== 'string' ||
      typeof parsed.createdAt !== 'number'
    ) {
      return null;
    }
    if (now - parsed.createdAt > TTL_MS) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* best-effort */
      }
      return null;
    }
    return parsed as StoredSession;
  } catch {
    return null;
  }
}

/** Persist the AER session for a harness session id. Best-effort, 0600, atomic. */
export function saveSession(
  harnessSessionId: string,
  session: StoredSession,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    const dir = cacheRoot(env);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Refuse a symlinked or non-directory cache dir: it could redirect the
    // token write. Degrade rather than follow it.
    const dirStat = fs.lstatSync(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return;
    // Tighten perms defensively in case the dir pre-existed under a loose umask.
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* best-effort */
    }
    const file = fileFor(env, harnessSessionId);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(session), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best-effort */
    }
  } catch {
    /* best-effort: a store failure degrades to per-event sessions, never throws */
  }
}

/** Remove the mapping for a harness session id (called on session end). */
export function deleteSession(
  harnessSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    fs.unlinkSync(fileFor(env, harnessSessionId));
  } catch {
    /* best-effort */
  }
}
