// Cross-process state for one harness session.
//
// A harness fires the hook once per event as a SEPARATE process, so what one
// invocation learns (the open AER session, the next seq, how far the
// transcript has been read, the events not yet accepted by the server) lives
// in a small per-user file keyed on the harness session id.

// The file holds an ingest token, so it is written 0600 in a 0700 directory
// owned by the user, and the token is removed when the record completes.
// Every operation is best-effort: a failure degrades and never throws, so a
// broken cache can never break the harness.

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** One event waiting for the server, already in its final shape except for the session id. */
export interface OutboxEvent {
  id: string;
  type: string;
  /** When the hook saw it, not when it was finally sent. */
  ts: string;
  payload: Record<string, unknown>;
  /** Failed sends so far; an event that keeps failing is eventually dropped and counted. */
  attempts?: number;

}

/** The AER session the current record is being written to. */
export interface OpenSession {
  id: string;
  ingestToken: string;
  baseUrl: string;
  openedAt: number;
  /** Complete this session before sending anything else (quiet period, full session). */
  closeFirst?: boolean;
}

export interface SessionState {
  v: 2;
  createdAt: number;
  lastActivityAt: number;
  /** The last seq handed out. Positions are assigned once, in order, and never reused. */
  seq: number;
  /** The first seq and the start time of the record currently being written. */
  segmentStartSeq: number;
  segmentStartedAt: number;
  /** Tool starts not yet matched by a completion. */
  toolsOpen: number;
  /** The Claude Code transcript read so far, for incremental llm.completed capture. */
  transcriptPath?: string;
  transcriptOffset?: number;
  emittedLlmMessageIds?: string[];
  /** Which harness events the installation wires, carried on every report. */
  eventsRegistered?: string[];
  session?: OpenSession;
  /** The invocation currently talking to the server for this harness session. */
  lease?: { owner: string; until: number };
  /** Consecutive failed opens and when the next may be tried. */
  openFailures?: number;
  retryOpenAt?: number;
  /** Complete the record once every queued event is accepted. */
  complete?: 'checkpoint' | 'end';
  /** The harness session ended and its record completed; kept only so a transcript is never read twice. */
  ended?: boolean;
  /** Events this record lost to a full queue or a send that kept failing. */
  droppedBudget: number;
  /** Network targets a shell line named that could not be reduced to a host. Local only. */
  hostsUnreduced?: number;
  outbox: OutboxEvent[];
  /**
   * The most events sent in one request since a batch ran its full request
   * time with no answer: half that batch, halved again on each such batch,
   * until the queue empties.
   */
  postLimit?: number;
}

/** Most events held for the server at once. Past this the oldest are dropped and counted. */
export const MAX_OUTBOX_EVENTS = 1000;

/** State untouched this long is presumed left by a harness that went away. */
const TTL_MS = 24 * 60 * 60 * 1000;

// ── where the state lives ───────────────────────────────────────────────────

function uidTag(): string {
  try {
    return typeof process.getuid === 'function' ? String(process.getuid()) : os.userInfo().username;
  } catch {
    return 'user';
  }
}

/**
 * Where state may be written, best first: the user cache dir, then the
 * per-user runtime dir, then a per-user directory under the temp dir. The
 * README promises the hook records even when the cache dir cannot be
 * written; the fallbacks are what keep that true.
 */
function candidateRoots(env: NodeJS.ProcessEnv): string[] {
  const xdg = env['XDG_CACHE_HOME'];
  const roots = [xdg && xdg.length > 0 ? path.join(xdg, 'aer-hooks') : path.join(os.homedir(), '.cache', 'aer-hooks')];
  const runtime = env['XDG_RUNTIME_DIR'];
  if (runtime && runtime.length > 0) roots.push(path.join(runtime, 'aer-hooks'));
  const tmp = env['TMPDIR'] && env['TMPDIR'].length > 0 ? env['TMPDIR'] : os.tmpdir();
  roots.push(path.join(tmp, `aer-hooks-${uidTag()}`));
  return roots;
}

/**
 * A directory is usable when it exists or can be made, is a real directory
 * rather than a link, belongs to this user and can be written. A shared temp
 * dir is only safe on those terms: a directory someone else made first, or a
 * link they planted, is refused.
 */
function usableRoot(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false;
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* best-effort */
    }
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const rootCache = new Map<string, string | null>();

/** The directory this environment's state lives in, or null when nowhere can be written. */
export function stateRoot(env: NodeJS.ProcessEnv): string | null {
  const roots = candidateRoots(env);
  const key = roots.join('\0');
  const known = rootCache.get(key);
  if (known !== undefined && (known === null || fs.existsSync(known))) return known;
  const found = roots.find(usableRoot) ?? null;
  rootCache.set(key, found);
  return found;
}

function digestOf(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 32);
}

function stateFile(root: string, storeKey: string): string {
  return path.join(root, `${digestOf(storeKey)}.json`);
}

function writeAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ── state ───────────────────────────────────────────────────────────────────

export function freshState(now: number): SessionState {
  return { v: 2, createdAt: now, lastActivityAt: now, seq: 0, segmentStartSeq: 1, segmentStartedAt: now, toolsOpen: 0, droppedBudget: 0, outbox: [] };
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function validOutbox(v: unknown): OutboxEvent[] {
  if (!Array.isArray(v)) return [];
  return v.filter((e): e is OutboxEvent =>
    typeof e === 'object' && e !== null && isStr(e.id) && isStr(e.type) && isStr(e.ts)
    && typeof e.payload === 'object' && e.payload !== null && !Array.isArray(e.payload));
}

/**
 * Read what an earlier release wrote: an open session with its position, or
 * a marker left while a session was being opened. The session carries on
 * rather than being reopened, so an upgrade mid-session keeps one record.
 */
function fromLegacy(p: Record<string, unknown>): SessionState | null {
  if (!isInt(p['createdAt'])) return null;
  const s = freshState(p['createdAt']);
  if (p['pending'] === true) return s;
  if (!isStr(p['aerSessionId']) || !isStr(p['ingestToken']) || !isStr(p['baseUrl'])) return null;
  s.session = { id: p['aerSessionId'], ingestToken: p['ingestToken'], baseUrl: p['baseUrl'], openedAt: p['createdAt'] };
  if (isInt(p['seq'])) s.seq = p['seq'];
  if (isInt(p['toolsOpen'])) s.toolsOpen = p['toolsOpen'];
  copyTranscript(p, s);
  return s;
}

function copyTranscript(p: Record<string, unknown>, s: SessionState): void {
  if (isStr(p['transcriptPath'])) {
    s.transcriptPath = p['transcriptPath'];
    s.transcriptOffset = isInt(p['transcriptOffset']) ? p['transcriptOffset'] : 0;
  }
  const ids = p['emittedLlmMessageIds'];
  if (Array.isArray(ids) && ids.every((x) => typeof x === 'string')) s.emittedLlmMessageIds = ids as string[];
}

function parseState(p: Record<string, unknown>): SessionState | null {
  if (p['v'] !== 2) return fromLegacy(p);
  if (!isInt(p['createdAt']) || !isInt(p['lastActivityAt']) || !isInt(p['seq'])) return null;
  const s = freshState(p['createdAt']);
  s.lastActivityAt = p['lastActivityAt'];
  s.seq = p['seq'];
  s.segmentStartSeq = isInt(p['segmentStartSeq']) ? p['segmentStartSeq'] : 1;
  s.segmentStartedAt = isInt(p['segmentStartedAt']) ? p['segmentStartedAt'] : s.createdAt;
  s.toolsOpen = isInt(p['toolsOpen']) ? p['toolsOpen'] : 0;
  s.droppedBudget = isInt(p['droppedBudget']) ? p['droppedBudget'] : 0;
  if (isInt(p['hostsUnreduced'])) s.hostsUnreduced = p['hostsUnreduced'];
  copyTranscript(p, s);
  const reg = p['eventsRegistered'];
  if (Array.isArray(reg) && reg.every((x) => typeof x === 'string')) s.eventsRegistered = reg as string[];
  const sess = p['session'] as Record<string, unknown> | undefined;
  if (sess && isStr(sess['id']) && isStr(sess['ingestToken']) && isStr(sess['baseUrl']) && isInt(sess['openedAt'])) {
    s.session = { id: sess['id'], ingestToken: sess['ingestToken'], baseUrl: sess['baseUrl'], openedAt: sess['openedAt'] };
    if (sess['closeFirst'] === true) s.session.closeFirst = true;
  }
  const lease = p['lease'] as Record<string, unknown> | undefined;
  const until = lease?.['until'];
  if (lease && isStr(lease['owner']) && typeof until === 'number' && Number.isFinite(until) && until >= 0) {
    s.lease = { owner: lease['owner'], until: Math.ceil(until) };
  }
  if (isInt(p['openFailures'])) s.openFailures = p['openFailures'];
  if (isInt(p['retryOpenAt'])) s.retryOpenAt = p['retryOpenAt'];
  if (p['complete'] === 'checkpoint' || p['complete'] === 'end') s.complete = p['complete'];
  if (p['ended'] === true) s.ended = true;
  if (isInt(p['postLimit']) && p['postLimit'] > 0) s.postLimit = p['postLimit'];
  s.outbox = validOutbox(p['outbox']);
  return s;
}

/** The state for a harness session, or null when there is none (or it expired). Best-effort. */
export function loadState(storeKey: string, env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): SessionState | null {
  const root = stateRoot(env);
  if (root === null) return null;
  const file = stateFile(root, storeKey);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const state = parseState(parsed as Record<string, unknown>);
    if (state === null) return null;
    if (now - state.lastActivityAt > TTL_MS) {
      try { fs.unlinkSync(file); } catch { /* best-effort */ }
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

/** Persist the state. Returns false when it could not be written. */
export function saveState(storeKey: string, state: SessionState, env: NodeJS.ProcessEnv = process.env): boolean {
  const root = stateRoot(env);
  if (root === null) return false;
  try {
    writeAtomic(stateFile(root, storeKey), state);
    return true;
  } catch {
    return false;
  }
}

export function deleteState(storeKey: string, env: NodeJS.ProcessEnv = process.env): void {
  const root = stateRoot(env);
  if (root === null) return;
  try {
    fs.unlinkSync(stateFile(root, storeKey));
  } catch {
    /* best-effort */
  }
}

/** Most files one sweep removes, so a crowded directory never stalls a hook. */
const SWEEP_MAX_UNLINKS = 200;
const SWEPT_NAME = /^(?:[0-9a-f]{32}\.json|(?:drop|pid)-[^/]+\.json|.+\.tmp|.+\.lock)$/;

/**
 * Remove state that sessions which never came back left behind: files of
 * ours untouched for longer than the TTL. A state file is kept after its
 * record completes, so a resumed session never re-reads its transcript;
 * without this sweep nothing else would ever remove it. Plain files only,
 * never through a link, at most SWEEP_MAX_UNLINKS per call. Returns how many
 * went.
 */
export function sweepStale(env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): number {
  const root = stateRoot(env);
  if (root === null) return 0;
  let removed = 0;
  try {
    for (const name of fs.readdirSync(root)) {
      if (removed >= SWEEP_MAX_UNLINKS) break;
      if (!SWEPT_NAME.test(name)) continue;
      const file = path.join(root, name);
      try {
        const st = fs.lstatSync(file);
        if (!st.isFile() || now - st.mtimeMs <= TTL_MS) continue;
        fs.unlinkSync(file);
        removed += 1;
      } catch {
        /* gone already, or not ours to remove */
      }
    }
  } catch {
    /* best-effort */
  }
  return removed;
}

/**
 * Queue events for the server, dropping the oldest past the cap. Returns how
 * many were dropped so the caller can count them where the record reports.
 */
export function enqueue(state: SessionState, events: OutboxEvent[]): number {
  state.outbox.push(...events);
  let overflow = state.outbox.length - MAX_OUTBOX_EVENTS;
  if (overflow <= 0) return 0;
  // The oldest go first, except the report that ends the session: it is what
  // completes the record, and it carries the count of what was dropped here.
  let dropped = 0;
  state.outbox = state.outbox.filter((e) => {
    if (overflow === 0 || isClosing(e)) return true;
    overflow -= 1;
    dropped += 1;
    return false;
  });
  state.droppedBudget += dropped;
  return dropped;
}

function isClosing(e: OutboxEvent): boolean {
  return e.type === 'collector.report' && e.payload['phase'] === 'session_end';
}

// ── pid aliases (the subagent fallback) ─────────────────────────────────────

const PID_ALIAS_TTL_MS = 24 * 60 * 60 * 1000;

function pidAliasFile(root: string, pid: string): string {
  return path.join(root, `pid-${pid}.json`);
}

/**
 * The identity a pid alias is checked against on read. `startTime` guards a
 * recycled pid; `agentId`/`baseUrl` guard attaching a subagent to a different
 * agent's or tenant's session. An absent field on either side is not checked.
 */
export interface PidAliasIdentity {
  startTime?: string | undefined;
  agentId?: string | undefined;
  baseUrl?: string | undefined;
}

/** Alias the harness process to the store key it started, for subagent hooks that carry no root id. */
export function savePidAlias(
  pid: string,
  storeKey: string,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
  identity: PidAliasIdentity = {},
): void {
  const root = stateRoot(env);
  if (root === null) return;
  try {
    writeAtomic(pidAliasFile(root, pid), { ref: storeKey, createdAt: now, ...identity });
  } catch {
    /* best-effort */
  }
}

/** The store key aliased to a harness process pid, or null when absent, expired or not ours. */
export function loadPidAlias(
  pid: string,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
  expected: PidAliasIdentity = {},
): string | null {
  const root = stateRoot(env);
  if (root === null) return null;
  try {
    const file = pidAliasFile(root, pid);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<PidAliasIdentity> & { ref?: unknown; createdAt?: unknown };
    if (typeof parsed.ref !== 'string' || typeof parsed.createdAt !== 'number') return null;
    if (now - parsed.createdAt > PID_ALIAS_TTL_MS) {
      try { fs.unlinkSync(file); } catch { /* best-effort */ }
      return null;
    }
    if (
      (expected.startTime !== undefined && parsed.startTime !== undefined && parsed.startTime !== expected.startTime) ||
      (expected.agentId !== undefined && parsed.agentId !== undefined && parsed.agentId !== expected.agentId) ||
      (expected.baseUrl !== undefined && parsed.baseUrl !== undefined && parsed.baseUrl !== expected.baseUrl)
    ) {
      return null;
    }
    return parsed.ref;
  } catch {
    return null;
  }
}

export function deletePidAlias(pid: string, env: NodeJS.ProcessEnv = process.env): void {
  const root = stateRoot(env);
  if (root === null) return;
  try {
    fs.unlinkSync(pidAliasFile(root, pid));
  } catch {
    /* best-effort */
  }
}

// ── drops noted before any state exists ─────────────────────────────────────

interface DropCounters {
  subagentEventsUnattached: number;
  eventsDroppedBudget: number;
  createdAt: number;
}

function dropCountersFile(root: string, storeKey: string): string {
  return path.join(root, `drop-${digestOf(storeKey)}.json`);
}

function bumpDropCounter(storeKey: string, field: 'subagentEventsUnattached' | 'eventsDroppedBudget', env: NodeJS.ProcessEnv, now: number): void {
  const root = stateRoot(env);
  if (root === null) return;
  try {
    const file = dropCountersFile(root, storeKey);
    const counters: DropCounters = { subagentEventsUnattached: 0, eventsDroppedBudget: 0, createdAt: now };
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DropCounters>;
      if (isInt(parsed.subagentEventsUnattached)) counters.subagentEventsUnattached = parsed.subagentEventsUnattached;
      if (isInt(parsed.eventsDroppedBudget)) counters.eventsDroppedBudget = parsed.eventsDroppedBudget;
      if (isInt(parsed.createdAt)) counters.createdAt = parsed.createdAt;
    } catch {
      /* no prior counter file */
    }
    counters[field] += 1;
    writeAtomic(file, counters);
  } catch {
    /* an uncounted drop is still a dropped event, never a thrown one */
  }
}

/** A subagent event found no lead to attach to and was dropped without opening a session. */
export function noteSubagentEventUnattached(storeKey: string, env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): void {
  bumpDropCounter(storeKey, 'subagentEventsUnattached', env, now);
}

/** An event could not be queued (the state stayed locked past the budget) and was dropped. */
export function noteEventDroppedBudget(storeKey: string, env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): void {
  bumpDropCounter(storeKey, 'eventsDroppedBudget', env, now);
}

/** The drop counters for a store key, without clearing them. */
export function readDropCounters(storeKey: string, env: NodeJS.ProcessEnv = process.env): { subagentEventsUnattached: number; eventsDroppedBudget: number } {
  const root = stateRoot(env);
  try {
    if (root === null) throw new Error('no root');
    const parsed = JSON.parse(fs.readFileSync(dropCountersFile(root, storeKey), 'utf8')) as Partial<DropCounters>;
    return {
      subagentEventsUnattached: isInt(parsed.subagentEventsUnattached) ? parsed.subagentEventsUnattached : 0,
      eventsDroppedBudget: isInt(parsed.eventsDroppedBudget) ? parsed.eventsDroppedBudget : 0,
    };
  } catch {
    return { subagentEventsUnattached: 0, eventsDroppedBudget: 0 };
  }
}

/** Clear the drop counters once the record they describe has completed. */
export function clearDropCounters(storeKey: string, env: NodeJS.ProcessEnv = process.env): void {
  const root = stateRoot(env);
  if (root === null) return;
  try {
    fs.unlinkSync(dropCountersFile(root, storeKey));
  } catch {
    /* best-effort */
  }
}

// ── the lock ────────────────────────────────────────────────────────────────

export interface SessionLock {
  /** Release the lock. Best-effort; never throws. */
  release(): void;
}

export interface AcquireLockOptions {
  /** Give up and return null after waiting this long. Default 3000ms. */
  maxWaitMs?: number;
  /** Interval between attempts while waiting. Default 10ms. */
  pollMs?: number;
  /** A lock file older than this is presumed left by a crashed holder and is taken over. Default 5000ms. */
  staleMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
  /** Test seam: runs between judging a lock stale and taking it over. */
  beforeTakeover?: () => void;
}

/**
 * Remove a lock judged stale, but only if it is still the one judged. Two
 * waiters can judge the same dead lock stale; a plain unlink by the slower
 * one would remove the lock the faster one has just taken. Moving it aside
 * first and checking what was moved keeps a live holder's lock: one that
 * turns out fresh is put back.
 */
function takeOverStale(lockFile: string, judgedOwner: string, staleMs: number, beforeTakeover?: () => void): void {
  beforeTakeover?.();
  const aside = `${lockFile}.${process.pid}.${randomBytes(4).toString('hex')}.stale`;
  try {
    fs.renameSync(lockFile, aside);
  } catch {
    return; // already gone; the next loop retries
  }
  try {
    const moved = fs.readFileSync(aside, 'utf8');
    const st = fs.statSync(aside);
    if (moved !== judgedOwner || Date.now() - st.mtimeMs <= staleMs) {
      try {
        fs.linkSync(aside, lockFile);
      } catch {
        /* a newer lock is already in place; leave it */
      }
    }
  } catch {
    /* best-effort */
  } finally {
    try {
      fs.unlinkSync(aside);
    } catch {
      /* best-effort */
    }
  }
}

// The lock covers reading and rewriting one small file and never a network
// call, so a holder keeps it for milliseconds. A lock this old was left by a
// process that died holding it.
export const LOCK_STALE_MS = 5000;
const LOCK_MAX_WAIT_MS = 3000;
const LOCK_POLL_MS = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The lock file for a store key, for tests that check it is never held across a network call. */
export function lockFileFor(storeKey: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const root = stateRoot(env);
  return root === null ? null : `${stateFile(root, storeKey)}.lock`;
}

/**
 * Take the exclusive lock for one harness session's state, so a read, decide
 * and write of that state is atomic across hook processes. An O_EXCL lock
 * file next to the state; the owner is stamped in it, so a holder that
 * overran and lost the lock never releases the next holder's. Returns null
 * when the state cannot be written at all or the wait runs out.
 */
export async function acquireSessionLock(
  storeKey: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: AcquireLockOptions = {},
): Promise<SessionLock | null> {
  const maxWaitMs = opts.maxWaitMs ?? LOCK_MAX_WAIT_MS;
  const pollMs = opts.pollMs ?? LOCK_POLL_MS;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const now = opts.now ?? Date.now;

  const lockFile = lockFileFor(storeKey, env);
  if (lockFile === null) return null;
  const deadline = now() + maxWaitMs;

  for (;;) {
    try {
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
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      try {
        const st = fs.statSync(lockFile);
        if (Date.now() - st.mtimeMs > staleMs) {
          takeOverStale(lockFile, fs.readFileSync(lockFile, 'utf8'), staleMs, opts.beforeTakeover);
          continue;
        }
      } catch {
        continue;
      }
      if (now() >= deadline) return null;
      await sleep(pollMs);
    }
  }
}
