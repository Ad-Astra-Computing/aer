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

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface StoredSession {
  aerSessionId: string;
  ingestToken: string;
  baseUrl: string;
  createdAt: number;
  /**
   * How many events this harness session has emitted so far, which is the
   * position the next one takes. Assigned under the same lock that decides
   * whether a session already exists, so two hooks racing for one harness
   * session cannot take the same position.
   */
  seq?: number;
  /**
   * Tool starts that have not yet been matched by a completion. A tool that
   * never completes is the difference between an agent that stopped and a
   * recorder that missed the end of the call.
   */
  toolsOpen?: number;
  /**
   * The Claude Code transcript this harness session has been read from so
   * far, for incremental llm.completed capture (model + token counts read
   * from the transcript, since no Claude Code hook payload carries them).
   * `transcriptOffset` is a BYTE offset into `transcriptPath`; a mismatch
   * between the stored path and the one on the current event means a fresh
   * transcript, so the offset resets to 0.
   */
  transcriptPath?: string;
  transcriptOffset?: number;
  /**
   * Assistant message ids already turned into an llm.completed, bounded so
   * the store never grows unbounded across a long session. Kept even across
   * a transcript offset reset (truncation/rotation) so a message already
   * recorded is never recorded twice.
   */
  emittedLlmMessageIds?: string[];
}

/**
 * A store slot before the upstream session is known: written by the lock
 * holder immediately before POST /v1/sessions so a concurrent reader sees
 * "opening" rather than "nothing yet". Carries the client_ref so a reopen
 * after a stale pending entry sends the identical value (ADR-023 B2).
 */
export interface PendingSession {
  pending: true;
  clientRef: string;
  createdAt: number;
}

export type SessionEntry = StoredSession | PendingSession;

export function isPending(entry: SessionEntry | null): entry is PendingSession {
  return entry !== null && (entry as PendingSession).pending === true;
}

/** A pending entry older than this is presumed abandoned by a killed opener. */
export const PENDING_STALE_MS = 15_000;

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

/** Look up the AER session (or a still-opening pending marker) for a harness session id, or null. Best-effort. */
export function loadSession(
  harnessSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): SessionEntry | null {
  try {
    const file = fileFor(env, harnessSessionId);
    const text = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(text) as Partial<StoredSession> & Partial<PendingSession>;

    if (parsed.pending === true) {
      if (typeof parsed.clientRef !== 'string' || typeof parsed.createdAt !== 'number') return null;
      if (now - parsed.createdAt > TTL_MS) {
        try { fs.unlinkSync(file); } catch { /* best-effort */ }
        return null;
      }
      return { pending: true, clientRef: parsed.clientRef, createdAt: parsed.createdAt };
    }

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
    // seq was added after the first release; an entry written by the older
    // build has none, and restarting the count is better than discarding a
    // live session over a missing counter.
    if (typeof parsed.seq !== 'number' || !Number.isInteger(parsed.seq) || parsed.seq < 0) {
      parsed.seq = 0;
    }
    // Transcript-tracking fields are newer than the store format and may be
    // absent or, from a corrupted write, malformed. A bad value here degrades
    // to "no transcript progress yet" rather than discarding the whole
    // session entry.
    if (typeof parsed.transcriptPath !== 'string' || parsed.transcriptPath.length === 0) {
      delete parsed.transcriptPath;
      delete parsed.transcriptOffset;
    } else if (
      typeof parsed.transcriptOffset !== 'number' ||
      !Number.isInteger(parsed.transcriptOffset) ||
      parsed.transcriptOffset < 0
    ) {
      parsed.transcriptOffset = 0;
    }
    if (
      !Array.isArray(parsed.emittedLlmMessageIds) ||
      !parsed.emittedLlmMessageIds.every((id) => typeof id === 'string')
    ) {
      delete parsed.emittedLlmMessageIds;
    }
    return parsed as StoredSession;
  } catch {
    return null;
  }
}

function writeEntry(file: string, env: NodeJS.ProcessEnv, data: unknown): void {
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
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best-effort */
  }
}

/** Persist the AER session for a harness session id. Best-effort, 0600, atomic. */
export function saveSession(
  harnessSessionId: string,
  session: StoredSession,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    writeEntry(fileFor(env, harnessSessionId), env, session);
  } catch {
    /* best-effort: a store failure degrades to per-event sessions, never throws */
  }
}

/**
 * Write the pending marker for a harness session id BEFORE the upstream open
 * call (ADR-023 B2), so a concurrent reader sees "opening" instead of
 * "nothing yet" and does not also try to open. Best-effort, 0600, atomic.
 */
export function savePendingSession(
  harnessSessionId: string,
  clientRef: string,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): void {
  try {
    writeEntry(fileFor(env, harnessSessionId), env, { pending: true, clientRef, createdAt: now });
  } catch {
    /* best-effort */
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

const PID_ALIAS_TTL_MS = 24 * 60 * 60 * 1000; // 24h, same as a session entry

function pidAliasFile(env: NodeJS.ProcessEnv, pid: string): string {
  return path.join(cacheRoot(env), `pid-${pid}.json`);
}

/**
 * Alias the harness process (identified by `pid`) to the store key it opened,
 * so a subagent hook fired from the same harness process can find the lead's
 * session even with no --root-session flag (ADR-023 B1 fallback). Written by
 * SessionStart, keyed on the hook's own PARENT pid (the harness process).
 */
export function savePidAlias(
  pid: string,
  storeKey: string,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): void {
  try {
    writeEntry(pidAliasFile(env, pid), env, { ref: storeKey, createdAt: now });
  } catch {
    /* best-effort */
  }
}

/** Look up the store key aliased to a harness process pid, or null. Best-effort. */
export function loadPidAlias(
  pid: string,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): string | null {
  try {
    const file = pidAliasFile(env, pid);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { ref?: unknown; createdAt?: unknown };
    if (typeof parsed.ref !== 'string' || typeof parsed.createdAt !== 'number') return null;
    if (now - parsed.createdAt > PID_ALIAS_TTL_MS) {
      try { fs.unlinkSync(file); } catch { /* best-effort */ }
      return null;
    }
    return parsed.ref;
  } catch {
    return null;
  }
}

/** Remove a pid alias (called on session end, mirroring the pid it was written under). */
export function deletePidAlias(pid: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    fs.unlinkSync(pidAliasFile(env, pid));
  } catch {
    /* best-effort */
  }
}

interface DropCounters {
  subagentEventsUnattached: number;
  eventsDroppedBudget: number;
  createdAt: number;
}

function dropCountersFile(env: NodeJS.ProcessEnv, storeKey: string): string {
  const digest = createHash('sha256').update(storeKey).digest('hex').slice(0, 32);
  return path.join(cacheRoot(env), `drop-${digest}.json`);
}

function bumpDropCounter(
  storeKey: string,
  field: 'subagentEventsUnattached' | 'eventsDroppedBudget',
  env: NodeJS.ProcessEnv,
  now: number,
): void {
  try {
    const file = dropCountersFile(env, storeKey);
    const counters: DropCounters = { subagentEventsUnattached: 0, eventsDroppedBudget: 0, createdAt: now };
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DropCounters>;
      if (typeof parsed.subagentEventsUnattached === 'number') counters.subagentEventsUnattached = parsed.subagentEventsUnattached;
      if (typeof parsed.eventsDroppedBudget === 'number') counters.eventsDroppedBudget = parsed.eventsDroppedBudget;
      if (typeof parsed.createdAt === 'number') counters.createdAt = parsed.createdAt;
    } catch {
      /* no prior counter file: start fresh */
    }
    counters[field] += 1;
    writeEntry(file, env, counters);
  } catch {
    /* best-effort: an uncounted drop is still a dropped event, never a thrown one */
  }
}

/** A subagent event found no lead to attach to and was dropped without opening a session. */
export function noteSubagentEventUnattached(storeKey: string, env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): void {
  bumpDropCounter(storeKey, 'subagentEventsUnattached', env, now);
}

/** A tool event lost the budget race for the lock and was dropped without opening a session. */
export function noteEventDroppedBudget(storeKey: string, env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): void {
  bumpDropCounter(storeKey, 'eventsDroppedBudget', env, now);
}

/** Read and clear the drop counters for a store key, for folding into the closing collector.report. */
export function takeDropCounters(storeKey: string, env: NodeJS.ProcessEnv = process.env): { subagentEventsUnattached: number; eventsDroppedBudget: number } {
  const file = dropCountersFile(env, storeKey);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DropCounters>;
    try { fs.unlinkSync(file); } catch { /* best-effort */ }
    return {
      subagentEventsUnattached: typeof parsed.subagentEventsUnattached === 'number' ? parsed.subagentEventsUnattached : 0,
      eventsDroppedBudget: typeof parsed.eventsDroppedBudget === 'number' ? parsed.eventsDroppedBudget : 0,
    };
  } catch {
    return { subagentEventsUnattached: 0, eventsDroppedBudget: 0 };
  }
}

export interface SessionLock {
  /** Release the lock. Best-effort; never throws. */
  release(): void;
}

export interface AcquireLockOptions {
  /** Give up and return null after spin-waiting this long. Default 8000ms. */
  maxWaitMs?: number;
  /** Interval between acquisition attempts while waiting. Default 25ms. */
  pollMs?: number;
  /** A lock file older than this is presumed left by a crashed holder and is stolen. Default 5000ms. */
  staleMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

const LOCK_MAX_WAIT_MS = 8000;
const LOCK_POLL_MS = 25;
const LOCK_STALE_MS = 5000;

function lockFileFor(env: NodeJS.ProcessEnv, harnessSessionId: string): string {
  return `${fileFor(env, harnessSessionId)}.lock`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire an exclusive lock for one harness session id, so that a read-decide-write
 * sequence (is there already an AER session for this harness session? if not, open
 * one and persist it) is atomic across concurrent hook processes. Without this,
 * two hooks that both call loadSession() before either calls saveSession() both
 * conclude "no session yet" and each open a separate upstream AER session,
 * orphaning one of them.
 *
 * Uses an O_EXCL ('wx') lock file next to the session-store entry. A lock older
 * than staleMs is presumed abandoned by a crashed process and is stolen, so a
 * dead holder can never wedge future invocations. Spin-waits asynchronously
 * (never blocks the event loop) up to maxWaitMs, then gives up and returns null
 * so the caller can degrade to recording its event on its own, best-effort.
 */
export async function acquireSessionLock(
  harnessSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: AcquireLockOptions = {},
): Promise<SessionLock | null> {
  const maxWaitMs = opts.maxWaitMs ?? LOCK_MAX_WAIT_MS;
  const pollMs = opts.pollMs ?? LOCK_POLL_MS;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const now = opts.now ?? Date.now;

  const dir = cacheRoot(env);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dirStat = fs.lstatSync(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return null;
  } catch {
    return null;
  }

  const lockFile = lockFileFor(env, harnessSessionId);
  const deadline = now() + maxWaitMs;

  for (;;) {
    try {
      // A holder that overran its lease finds the lock stolen. Stamp who we
      // are, so releasing late unlinks nothing and the new holder keeps it.
      const owner = `${process.pid}.${randomBytes(8).toString('hex')}`;
      const fd = fs.openSync(lockFile, 'wx', 0o600);
      try {
        fs.writeSync(fd, owner);
      } finally {
        fs.closeSync(fd);
      }
      return {
        release: () => {
          try {
            if (fs.readFileSync(lockFile, 'utf8') !== owner) return;
            fs.unlinkSync(lockFile);
          } catch {
            /* best-effort */
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null; // unexpected fs failure: degrade
      try {
        const st = fs.statSync(lockFile);
        if (now() - st.mtimeMs > staleMs) {
          try {
            fs.unlinkSync(lockFile);
          } catch {
            /* another process may already be clearing it; the next loop retries the create */
          }
          continue;
        }
      } catch {
        continue; // the lock vanished between the EEXIST and the stat; retry immediately
      }
      if (now() >= deadline) return null;
      await sleep(pollMs);
    }
  }
}
