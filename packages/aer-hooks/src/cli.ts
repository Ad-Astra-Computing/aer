#!/usr/bin/env node
// aer-hook - the per-event hook binary.
//
// A harness runs this with the hook event JSON on stdin. We read all of stdin,
// parse it tolerantly, normalize it (harness from --harness or auto-detected),
// emit it via sinkFromEnv() and close.
//
// FAIL-OPEN + NON-BLOCKING is the #1 property. A hook that errors, hangs or is
// misconfigured must NEVER break or slow the harness. Everything is wrapped in
// try/catch, total runtime is capped by a hard timeout after which we exit 0
// regardless, and we NEVER write to stdout (some harnesses interpret hook stdout).

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import {
  createHttpSink,
  resolveSinkOptionsFromEnv,
  deriveClientRef,
  type EventSink,
  type HttpSinkOptions,
} from '@adastracomputing/aer-emit';
import { normalize, type Harness, type HookEvent, type Lifecycle } from './normalize.js';
import { emitHookEvent } from './core.js';
import {
  loadSession,
  saveSession,
  savePendingSession,
  deleteSession,
  acquireSessionLock,
  isPending,
  savePidAlias,
  loadPidAlias,
  deletePidAlias,
  noteSubagentEventUnattached,
  noteEventDroppedBudget,
  takeDropCounters,
  PENDING_STALE_MS,
  type StoredSession,
  type SessionEntry,
} from './session-store.js';
import {
  scanTranscriptForLlmUsage,
  emitLlmUsageEvents,
  type TranscriptUsageState,
} from './claude-code-transcript.js';
import type { LlmUsageEvent } from './transcript-tail.js';
import { isInvokedDirectly } from './invoked-directly.js';
import { registeredEvents, repoHead, HOOKS_VERSION } from './evidence.js';

// Production POST /v1/sessions has been measured at 3-4s (see aer-hooks README
// and the tenant-key Argon2id verification cost noted in the project docs), so
// the default budget needs headroom over that, not just over a fast local call.
const DEFAULT_HARD_TIMEOUT_MS = 10000;

// Budget constants (ADR-023 B2). One deadline is computed per invocation; the
// lock wait and the polling cutoffs are all measured against it so a slow open
// never leaves a tool event stranded past the harness's own hook timeout.
const LOCK_WAIT_CAP_MS = 3000;
const LOCK_WAIT_DEADLINE_MARGIN_MS = 4500;
const POLL_DEADLINE_MARGIN_MS = 500;
const POLL_INTERVAL_MS = 100;

/**
 * Parse AER_HOOK_TIMEOUT_MS: a positive integer, in ms, or unset. An unset or
 * invalid value falls back to DEFAULT_HARD_TIMEOUT_MS; an invalid one is
 * reported once so a typo does not silently pick the default.
 */
export function parseHardTimeoutMs(env: NodeJS.ProcessEnv, warn: (message: string) => void): number | undefined {
  const raw = env['AER_HOOK_TIMEOUT_MS'];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    warn(`aer-hook: ignoring invalid AER_HOOK_TIMEOUT_MS=${JSON.stringify(raw)}; using the default`);
    return undefined;
  }
  return n;
}

export function parseHarnessFlag(argv: string[]): Harness | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--harness') {
      const v = argv[i + 1];
      if (v === 'claude-code' || v === 'codex' || v === 'antigravity') return v;
      // `agy` is what people type for Antigravity, so both spellings work.
      if (v === 'agy') return 'antigravity';
    } else if (a === '--harness=claude-code') {
      return 'claude-code';
    } else if (a === '--harness=codex') {
      return 'codex';
    } else if (a === '--harness=antigravity' || a === '--harness=agy') {
      return 'antigravity';
    }
  }
  return undefined;
}

/**
 * Antigravity is the one harness that does not name the event in its payload,
 * so its registrations pass it on argv instead.
 */
export function parseEventFlag(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--event') return argv[i + 1];
    if (a !== undefined && a.startsWith('--event=')) return a.slice('--event='.length);
  }
  return undefined;
}

/**
 * Which lifecycle registration invoked us. The installer stamps
 * `--lifecycle v2` on every command it writes; an entry written by an earlier
 * release has no flag, and must keep completing its record on `Stop` because
 * it never registered `SessionEnd` at all.
 */
export function parseLifecycleFlag(argv: string[]): Lifecycle {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lifecycle=v2') return 2;
    if (a === '--lifecycle' && argv[i + 1] === 'v2') return 2;
  }
  return 1;
}

// The literal string a shell that never expanded the substitution would pass
// through verbatim - happens when the harness invokes the command without a
// shell, or on a platform whose shell quotes differently. Treated as absent
// rather than used as a session key everyone's subagents would collide on.
const UNEXPANDED_ROOT_SESSION = '${CLAUDE_SESSION_ID}';

/**
 * The lead harness session id (ADR-023 B1), when the installer's
 * `--root-session` flag carried a real value. Absent, empty, or still the
 * unexpanded placeholder all mean "no root session named"; the caller falls
 * back to the event's own session id.
 */
export function parseRootSessionFlag(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let raw: string | undefined;
    if (a === '--root-session') raw = argv[i + 1];
    else if (a !== undefined && a.startsWith('--root-session=')) raw = a.slice('--root-session='.length);
    if (raw !== undefined) {
      if (raw.length === 0 || raw === UNEXPANDED_ROOT_SESSION) return undefined;
      return raw;
    }
  }
  return undefined;
}

async function readStdin(): Promise<string> {
  // If stdin is a TTY there is no piped payload; return empty rather than hang.
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  return await new Promise<string>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    process.stdin.on('close', done);
  });
}

export interface RunHookDeps {
  /** Injectable stdin reader for tests. Defaults to reading process.stdin. */
  readInput?: () => Promise<string>;
  /** Injectable fetch for tests. */
  fetch?: typeof fetch;
  /** Injectable clock for the session-store TTL / createdAt. */
  now?: () => number;
  /** Injectable hard-timeout budget (ms), so the deadline math is testable without real waits. */
  hardTimeoutMs?: number;
  /**
   * Injectable ancestor-pid walk for the subagent fallback (ADR-023 B1),
   * so tests never touch a real /proc or spawn `ps`. Given a pid, returns
   * its parent pid or undefined when it cannot be determined.
   */
  parentPidOf?: (pid: number) => number | undefined;
  /** Injectable "own parent pid" for tests, in place of the real process.ppid. */
  ownPpid?: number;
}

/**
 * What the collector was set up to see, attached to the opening marker. A
 * reader comparing this with the events that arrived can tell a quiet session
 * from one where the recorder was never called.
 */
async function openingEvidence(event: HookEvent): Promise<void> {
  const meta = event.meta ?? (event.meta = {});
  meta['collector'] = 'aer-hooks';
  meta['version'] = HOOKS_VERSION;
  const harness = meta['harness'];
  if (harness === 'claude-code' || harness === 'codex' || harness === 'antigravity') {
    const registered = await registeredEvents(harness, undefined, event.cwd);
    if (registered.length > 0) meta['events_registered'] = registered;
  }
  const head = repoHead(event.cwd);
  if (head !== undefined) meta['repo_head'] = head;
}

/** What actually arrived, attached to the closing marker. */
function closingEvidence(event: HookEvent, toolsOpen: number, drops: { subagentEventsUnattached: number; eventsDroppedBudget: number }): void {
  const meta = event.meta ?? (event.meta = {});
  meta['collector'] = 'aer-hooks';
  meta['version'] = HOOKS_VERSION;
  // Counting the closing marker itself, which is about to go out.
  meta['events_emitted'] = event.seq ?? 1;
  meta['tools_unresolved'] = toolsOpen;
  if (drops.subagentEventsUnattached > 0) meta['subagent_events_unattached'] = drops.subagentEventsUnattached;
  if (drops.eventsDroppedBudget > 0) meta['events_dropped_budget'] = drops.eventsDroppedBudget;
}

/**
 * Build the sink for one already-decided branch, emit the event plus any
 * already-scanned Claude Code transcript usage events, and close it. The
 * usage events are pre-scanned (rather than scanned here) so a caller that
 * must reserve session-store state before the network call, the way `seq`
 * already is, can do so.
 */
async function emitThrough(event: HookEvent, sink: EventSink, llmUsageEvents: LlmUsageEvent[] = []): Promise<number> {
  const count = emitHookEvent(event, sink);
  emitLlmUsageEvents(llmUsageEvents, sink, event.sessionRef);
  await sink.close();
  return count;
}

/** The transcript-tracking fields a stored session carries, or none for a fresh one. */
function transcriptStateOf(stored: StoredSession | null): TranscriptUsageState {
  if (!stored) return {};
  const state: TranscriptUsageState = {};
  if (stored.transcriptPath !== undefined) state.transcriptPath = stored.transcriptPath;
  if (stored.transcriptOffset !== undefined) state.transcriptOffset = stored.transcriptOffset;
  if (stored.emittedLlmMessageIds !== undefined) state.emittedLlmMessageIds = stored.emittedLlmMessageIds;
  return state;
}

/**
 * How many events this invocation will emit. The position has to be reserved
 * before the network call, so it cannot be counted after one.
 */
export function plannedEventCount(event: HookEvent): number {
  if (event.kind === 'other') return 0;
  if (event.kind === 'tool_start') return event.shape === undefined ? 1 : 2;
  return 1;
}

/** A tool start opens a call and a tool end closes one. Never below zero. */
function nextToolsOpen(open: number, kind: HookEvent['kind']): number {
  if (kind === 'tool_start') return open + 1;
  if (kind === 'tool_end') return Math.max(0, open - 1);
  return open;
}

function isSubagentEvent(event: HookEvent): boolean {
  return typeof event.meta?.['harness_agent_id'] === 'string';
}

// ── ancestor-pid walk (ADR-023 B1 fallback) ─────────────────────────────────

function ppidViaProc(pid: number): number | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const ppid = Number(fields[1]);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined;
  } catch {
    return undefined;
  }
}

function ppidViaPs(pid: number): number | undefined {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 500 });
    const ppid = Number(out.trim());
    return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined;
  } catch {
    return undefined;
  }
}

function defaultParentPidOf(pid: number): number | undefined {
  return process.platform === 'linux' ? ppidViaProc(pid) : ppidViaPs(pid);
}

/** Up to `maxCount` pids, starting at `startPid` and walking up through its ancestors. Fail-soft. */
function ancestorPids(startPid: number, maxCount: number, parentPidOf: (pid: number) => number | undefined): number[] {
  const pids: number[] = [];
  let pid = startPid;
  for (let i = 0; i < maxCount; i++) {
    pids.push(pid);
    const parent = parentPidOf(pid);
    if (parent === undefined) break;
    pid = parent;
  }
  return pids;
}

/**
 * A subagent event with no --root-session and no entry under its own session
 * id: find the lead's store key by walking up to three ancestor pids and
 * checking each for a SessionStart pid alias. Fail-soft at every step.
 */
function walkPidAliasForLead(env: NodeJS.ProcessEnv, now: number, deps: RunHookDeps): string | undefined {
  const ownPpid = deps.ownPpid ?? process.ppid;
  const parentPidOf = deps.parentPidOf ?? defaultParentPidOf;
  for (const pid of ancestorPids(ownPpid, 3, parentPidOf)) {
    const alias = loadPidAlias(String(pid), env, now);
    if (alias !== null) return alias;
  }
  return undefined;
}

// ── budget: polling helpers (ADR-023 B2) ────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll the store until a REAL (non-pending) session appears under `storeKey`,
 * or `pollDeadline` (an absolute ms timestamp) passes. Never holds a lock;
 * a caller that gets a hit still has to attach without one, best-effort.
 */
async function pollForRealSession(
  storeKey: string,
  env: NodeJS.ProcessEnv,
  pollDeadline: number,
  clock: () => number,
): Promise<StoredSession | null> {
  for (;;) {
    const entry = loadSession(storeKey, env, clock());
    if (entry !== null && !isPending(entry)) return entry;
    if (clock() >= pollDeadline) return null;
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Attach one event to an already-open session, best-effort. Reserves seq under `lockHeld`. */
async function attachToStored(
  event: HookEvent,
  stored: StoredSession,
  base: HttpSinkOptions,
  storeKey: string,
  env: NodeJS.ProcessEnv,
  now: number,
  lockHeld: boolean,
): Promise<void> {
  event.seq = (stored.seq ?? 0) + 1;
  const toolsOpen = nextToolsOpen(stored.toolsOpen ?? 0, event.kind);
  const scan = scanTranscriptForLlmUsage(event, transcriptStateOf(stored));
  // Persisting the advanced seq/toolsOpen without the lock risks clobbering a
  // concurrent writer; a caller that reached here without the lock (the
  // budget-poll paths) skips the write and accepts an approximate position,
  // which is honest (a gap, never a duplicate) rather than silently wrong.
  if (lockHeld) {
    saveSession(storeKey, { ...stored, seq: (stored.seq ?? 0) + plannedEventCount(event), toolsOpen, ...scan.state }, env);
  }
  const sink = createHttpSink({ ...base, session: { id: stored.aerSessionId, ingestToken: stored.ingestToken }, completeOnClose: false });
  await emitThrough(event, sink, scan.events);
  void now;
}

/** A tool event that lost the lock race: poll for the lead's session and attach, or give up. */
async function pollAndAttach(
  storeKey: string,
  event: HookEvent,
  base: HttpSinkOptions,
  env: NodeJS.ProcessEnv,
  now: number,
  deadline: number,
): Promise<boolean> {
  const pollDeadline = deadline - POLL_DEADLINE_MARGIN_MS;
  const stored = await pollForRealSession(storeKey, env, pollDeadline, Date.now);
  if (stored === null) return false;
  await attachToStored(event, stored, base, storeKey, env, now, false);
  return true;
}

async function orchestrateAndEmit(
  event: HookEvent,
  base: HttpSinkOptions,
  env: NodeJS.ProcessEnv,
  now: number,
  opts: { rootSession: string | undefined; deadline: number; deps: RunHookDeps },
): Promise<void> {
  const ref = event.sessionRef;
  if (!ref) {
    // No correlation id: single-shot session (open + emit + complete on close).
    await emitThrough(event, createHttpSink(base));
    return;
  }

  const isSubagent = isSubagentEvent(event);
  let storeKey = opts.rootSession ?? ref;

  // No root-session named for this invocation, and this is a subagent event:
  // find the lead by its own session id first, then the pid-alias fallback.
  // A subagent event that finds no lead here or after opening the lock below
  // MUST NOT open a session (ADR-023 B1).
  if (opts.rootSession === undefined && isSubagent && loadSession(storeKey, env, now) === null) {
    const alias = walkPidAliasForLead(env, now, opts.deps);
    if (alias === undefined) {
      noteSubagentEventUnattached(storeKey, env, now);
      return;
    }
    storeKey = alias;
  }

  const lockWaitMs = Math.max(0, Math.min(LOCK_WAIT_CAP_MS, opts.deadline - now - LOCK_WAIT_DEADLINE_MARGIN_MS));
  const lock = await acquireSessionLock(storeKey, env, { maxWaitMs: lockWaitMs });
  if (!lock) {
    if (event.kind === 'tool_start' || event.kind === 'tool_end') {
      const attached = await pollAndAttach(storeKey, event, base, env, now, opts.deadline);
      if (!attached) noteEventDroppedBudget(storeKey, env, now);
      return;
    }
    // Could not converge with a concurrent hook for this harness session in
    // time (or the store is unwritable): degrade to single-shot rather than
    // risk reading a half-written entry or waiting indefinitely.
    await emitThrough(event, createHttpSink(base));
    return;
  }

  try {
    let entry: SessionEntry | null = loadSession(storeKey, env, now);

    // A pending marker left by a concurrent opener: wait for it to resolve
    // rather than duplicate the open, unless it is stale (the opener was
    // killed), in which case fall through and reopen with the same client_ref.
    if (entry !== null && isPending(entry)) {
      const age = now - entry.createdAt;
      if (age < PENDING_STALE_MS) {
        const resolved = await pollForRealSession(storeKey, env, opts.deadline - POLL_DEADLINE_MARGIN_MS, Date.now);
        if (resolved !== null) entry = resolved;
        else entry = null; // give up waiting; open below (client_ref dedupes if the stuck opener finishes)
      } else {
        entry = null;
      }
    }

    const stored: StoredSession | null = entry !== null && !isPending(entry) ? entry : null;

    if (event.kind === 'session_end') {
      let completed = false;
      const drops = takeDropCounters(storeKey, env);
      const sink = stored
        ? createHttpSink({
            ...base,
            session: { id: stored.aerSessionId, ingestToken: stored.ingestToken },
            completeOnClose: true,
            onComplete: (ok) => { completed = ok; },
          })
        : createHttpSink(base); // never saw a start; single-shot
      if (stored) event.seq = (stored.seq ?? 0) + 1;
      closingEvidence(event, stored?.toolsOpen ?? 0, drops);
      const scan = scanTranscriptForLlmUsage(event, transcriptStateOf(stored));
      await emitThrough(event, sink, scan.events);
      if (stored && completed) {
        deleteSession(storeKey, env);
        if (!isSubagent) deletePidAlias(String(opts.deps.ownPpid ?? process.ppid), env);
      }
      return;
    }

    if (stored) {
      await attachToStored(event, stored, base, storeKey, env, now, true);
      return;
    }

    // No open session found for this store key after the pending check.
    if (isSubagent) {
      // Either the probe above found nothing under the alias either, or the
      // lead's session vanished between the probe and now: never open on a
      // subagent's behalf.
      noteSubagentEventUnattached(storeKey, env, now);
      return;
    }

    // First event for this harness session (session_start, or a tool event
    // that arrived before any start): open one, persist it as soon as it is
    // known, then emit, all while still holding the lock.
    event.seq = 1;
    if (event.kind === 'session_start') {
      await openingEvidence(event);
      savePidAlias(String(opts.deps.ownPpid ?? process.ppid), storeKey, env, now);
    }
    const scan = scanTranscriptForLlmUsage(event, {});
    const harnessName = typeof event.meta?.['harness'] === 'string' ? (event.meta['harness'] as string) : '';
    const clientRef = deriveClientRef(harnessName, storeKey, base.agentId ?? '');
    savePendingSession(storeKey, clientRef, env, now);
    const persist = (info: { id: string; ingestToken: string }): void => {
      saveSession(
        storeKey,
        { aerSessionId: info.id, ingestToken: info.ingestToken, baseUrl: base.baseUrl, createdAt: now, seq: plannedEventCount(event), toolsOpen: nextToolsOpen(0, event.kind), ...scan.state },
        env,
      );
    };
    const sink = createHttpSink({ ...base, completeOnClose: false, onOpen: persist, clientRef });
    await emitThrough(event, sink, scan.events);
  } finally {
    lock.release();
  }
}

/**
 * Run one hook. Resolves normally on every path. Exported for tests so the exit-0
 * guarantee can be exercised without spawning a process.
 */
export async function runHook(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  deps: RunHookDeps = {},
): Promise<void> {
  try {
    const harness = parseHarnessFlag(argv);
    const overrides = deps.fetch ? { fetch: deps.fetch } : {};
    const resolved = resolveSinkOptionsFromEnv(env, overrides);
    // Unconfigured: do nothing, touch no network.
    if (!resolved) return;
    // A harness records tool lifecycle through hooks and never watches the
    // wire, so mark it as such rather than inherit the wrapper default, which
    // means the auto-node collector did watch it.
    const base = {
      ...resolved,
      sourceType: 'harness' as const,
      // Declare who is recording, so a reader can tell a harness recording
      // from a wrapped process without inferring it from the events.
      collector: { name: 'aer-hooks', version: HOOKS_VERSION },
    };

    const input = await (deps.readInput ?? readStdin)();
    if (!input.trim()) return;
    let payload: unknown;
    try {
      payload = JSON.parse(input);
    } catch {
      // Malformed payload: fail open, nothing to record.
      return;
    }
    const now = (deps.now ?? Date.now)();
    const event = normalize(payload, harness, parseEventFlag(argv), parseLifecycleFlag(argv));
    const hardTimeoutMs = deps.hardTimeoutMs ?? parseHardTimeoutMs(env, () => undefined) ?? DEFAULT_HARD_TIMEOUT_MS;
    const rootSession = parseRootSessionFlag(argv);
    await orchestrateAndEmit(event, base, env, now, { rootSession, deadline: now + hardTimeoutMs, deps });
  } catch {
    /* fail open: never surface an error to the harness */
  }
}

/**
 * Entry point: run the hook but never exceed the hard timeout, then return so the
 * caller can exit 0 regardless. If the budget is exceeded, writes one stderr line
 * (never a token) so a slow/hanging AER endpoint is visible without ever blocking
 * or failing the harness's tool.
 */
export async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  deps: RunHookDeps = {},
): Promise<void> {
  // Answered before anything else: this must not wait on stdin, reach the
  // network, or sit behind the hook timeout. A support conversation starts
  // with which version wrote the record.
  if (argv.some((a) => a === '--version' || a === '-V')) {
    try {
      process.stdout.write(HOOKS_VERSION + '\n');
    } catch {
      /* stdout may already be gone; never throw from a diagnostic */
    }
    return;
  }

  const hardTimeoutMs = parseHardTimeoutMs(env, (message) => {
    try {
      process.stderr.write(message + '\n');
    } catch {
      /* stderr may already be gone; never throw from a diagnostic */
    }
  }) ?? DEFAULT_HARD_TIMEOUT_MS;

  let timedOut = false;
  const timeout = new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      timedOut = true;
      resolve();
    }, hardTimeoutMs);
    // Do not keep the event loop alive solely for the timeout.
    if (typeof t.unref === 'function') t.unref();
  });
  try {
    await Promise.race([runHook(argv, env, { ...deps, hardTimeoutMs: deps.hardTimeoutMs ?? hardTimeoutMs }), timeout]);
  } catch {
    /* fail open */
  }
  if (timedOut) {
    try {
      process.stderr.write(`aer-hook: timed out after ${hardTimeoutMs}ms; the AER record for this event may be incomplete\n`);
    } catch {
      /* stderr may already be gone; never throw from a diagnostic */
    }
  }
}

// Only run when executed as a binary, not when imported by tests. Must resolve
// symlinks: the harness runs this through the `aer-hook` node_modules/.bin
// symlink, whose name never matched the old endsWith('cli.js') check.
if (isInvokedDirectly(import.meta.url)) {
  void main().finally(() => {
    // Always exit 0 quickly, whatever happened above.
    process.exit(0);
  });
}
