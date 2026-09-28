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

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createHttpSink,
  resolveSinkOptionsFromEnv,
  deriveClientRef,
  type EventSink,
  type HttpSinkOptions,
} from '@adastracomputing/aer-emit';
import { normalize, type Harness, type HookEvent, type Lifecycle } from './normalize.js';
import { emitHookEvent, shapesOf } from './core.js';
import {
  loadState,
  saveState,
  freshState,
  enqueue,
  stateRoot,
  sweepStale,
  acquireSessionLock,
  savePidAlias,
  loadPidAlias,
  deletePidAlias,
  noteSubagentEventUnattached,
  noteEventDroppedBudget,
  readDropCounters,
  clearDropCounters,
  type SessionState,
  type OutboxEvent,
  type OpenSession,
} from './session-store.js';
import {
  scanTranscriptForLlmUsage,
  emitLlmUsageEvents,
  type TranscriptUsageState,
} from './claude-code-transcript.js';
import { isInvokedDirectly } from './invoked-directly.js';
import { envWithFile, parseEnvFileFlag } from './env-file.js';
import { registeredEvents, repoHead, HOOKS_VERSION } from './evidence.js';
import { stripToIngestPayload } from './shared/ingest-allowlist.js';
import { openSession, postEvents, completeSession, isRetryable, type ApiBase, type CallResult } from './transport.js';

// Production POST /v1/sessions has been measured at 3-4s (see aer-hooks README
// and the tenant-key Argon2id verification cost noted in the project docs), so
// the default budget needs headroom over that, not just over a fast local call.
const DEFAULT_HARD_TIMEOUT_MS = 10000;

export const DEFAULT_AGENT_VERSION = 'unspecified';

// The lock covers local state only, so it is held for milliseconds; a wait
// this long means a holder died, and its lock goes stale soon after.
const LOCK_WAIT_MS = 3000;
// Never start a network call with less time than this left, and stop each
// one this far short of the deadline, so no call is cut off by the process
// exiting with its outcome unrecorded.
const MIN_CALL_MS = 400;
const EXIT_MARGIN_MS = 300;
const REQUEST_TIMEOUT_MS = 8000;
// How long past its own deadline an invocation's claim on the network role
// lasts, so a killed invocation's claim lapses on its own.
const LEASE_GRACE_MS = 1000;
// Events per POST, far under the server's per-request cap.
const POST_BATCH = 100;
// A queued event that fails this many sends is dropped and counted, so one
// the server never takes cannot hold up the rest forever.
const MAX_SEND_ATTEMPTS = 5;
const MAX_ROUNDS = 40;
// How long after the hook process started a session end may still deliver
// itself, when its entry declares no budget, before leaving the rest to the
// worker. Claude Code gives a SessionEnd hook with no timeout 1.5 s from
// start, then cancels it.
const SESSION_END_INLINE_MS = 1200;
// How long the worker that finishes a session end may take, and how much
// longer before it is stopped whatever it is doing.
const DRAIN_BUDGET_MS = 60_000;
const DRAIN_HARD_STOP_MS = DRAIN_BUDGET_MS + 5_000;
// The worker's diagnostics file in the state dir is kept below this.
const DRAIN_LOG_MAX_BYTES = 64 * 1024;
const OPEN_BACKOFF_BASE_MS = 2000;
const OPEN_BACKOFF_MAX_MS = 5 * 60_000;
// A record is completed at the first turn end once it is this old, and before
// the next event once the harness has been quiet for the second. Four hours
// keeps a working afternoon in one record; an hour of quiet is a real break.
const DEFAULT_CHECKPOINT_MINUTES = 240;
const DEFAULT_QUIET_MINUTES = 60;
// And once it holds this many events, well under the server's per-session cap.
const CHECKPOINT_EVENTS = 20_000;

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

function minutesMs(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number(raw);
  return (Number.isInteger(n) && n >= 0 ? n : fallback) * 60_000;
}

/**
 * The two record-splitting triggers, in milliseconds, each 0 when turned off:
 * AER_HOOK_CHECKPOINT_MINUTES (record age at a turn end) and
 * AER_HOOK_QUIET_MINUTES (quiet time before the next event).
 */
export function parseCheckpointMs(env: NodeJS.ProcessEnv): { ageMs: number; quietMs: number } {
  return {
    ageMs: minutesMs(env['AER_HOOK_CHECKPOINT_MINUTES'], DEFAULT_CHECKPOINT_MINUTES),
    quietMs: minutesMs(env['AER_HOOK_QUIET_MINUTES'], DEFAULT_QUIET_MINUTES),
  };
}

/**
 * The time the harness allows the entry that ends a session, from
 * `--end-budget-ms`, which the installer writes on that entry. Undefined when
 * absent or not a positive whole number.
 */
export function parseEndBudgetMs(argv: string[]): number | undefined {
  let raw: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--end-budget-ms') raw = argv[i + 1];
    else if (a.startsWith('--end-budget-ms=')) raw = a.slice('--end-budget-ms='.length);
  }
  if (raw === undefined || !/^[1-9][0-9]{0,6}$/.test(raw)) return undefined;
  return Number(raw);
}

// A declared session end budget is never honoured past this, whatever the
// entry says: a hand-edited config must not hold the harness for minutes.
const MAX_END_BUDGET_MS = 30_000;

/** How long a session end with a declared budget may run: the budget, at most 30 s. */
export function endBudgetWindowMs(argv: string[]): number | undefined {
  const b = parseEndBudgetMs(argv);
  return b === undefined ? undefined : Math.min(b, MAX_END_BUDGET_MS);
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

// The literal string a shell that never expanded a substitution would pass
// through verbatim - happens when the harness invokes the command without a
// shell, or on a platform whose shell quotes differently. Treated as absent
// rather than used as a session key everyone's subagents would collide on.
const UNEXPANDED_ROOT_SESSION = '${CLAUDE_SESSION_ID}';

/**
 * An explicit `--root-session` override on argv, taking priority over
 * everything else (ADR-023 B1). Empty or still the unexpanded placeholder
 * both mean "nothing explicit was given".
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

// Claude Code 2.1.281 exports CLAUDE_CODE_SESSION_ID into the hook process's
// own env, identically for the lead and a subagent (verified 25 Sep 2026;
// the command-flag shell substitution was found empty). CLAUDE_SESSION_ID is
// read too, for a future release or another harness that uses that name.
export function rootSessionFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const v = env['CLAUDE_CODE_SESSION_ID'] ?? env['CLAUDE_SESSION_ID'];
  return v !== undefined && v.length > 0 ? v : undefined;
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
  /** Injectable process-start-time lookup for tests (ADR-023 B3 review, pid-alias identity guard). */
  processStartTime?: (pid: number) => string | undefined;
  /** Where the one-line diagnostics go. Defaults to stderr. */
  logError?: (message: string) => void;
  /**
   * Start the worker that finishes a session end after the hook returns,
   * given its arguments. Returns whether it started. Defaults to a detached
   * process outside the harness's reach; an injected fetch (a test) means
   * no worker unless this is given too.
   */
  handOff?: (drainArgv: string[]) => boolean;
  /**
   * When this hook's process started, epoch ms, which is when the harness's
   * clock for it started too. Defaults to when runHook was called.
   */
  processStart?: number;
  /** The time a request may take, for tests. Defaults to REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number;
  /** The worker's budget, for tests. Never more than DRAIN_BUDGET_MS. */
  drainBudgetMs?: number;
}

/** The transcript-tracking fields a state carries, or none for a fresh one. */
function transcriptStateOf(state: SessionState): TranscriptUsageState {
  const out: TranscriptUsageState = {};
  if (state.transcriptPath !== undefined) out.transcriptPath = state.transcriptPath;
  if (state.transcriptOffset !== undefined) out.transcriptOffset = state.transcriptOffset;
  if (state.emittedLlmMessageIds !== undefined) out.emittedLlmMessageIds = state.emittedLlmMessageIds;
  return out;
}

/**
 * How many events one hook event produces, not counting model calls read
 * from the transcript alongside it.
 */
export function plannedEventCount(event: HookEvent): number {
  if (event.kind === 'other') return 0;
  if (event.kind === 'tool_start') return 1 + shapesOf(event).length;
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

function harnessOf(event: HookEvent): string {
  return typeof event.meta?.['harness'] === 'string' ? (event.meta['harness'] as string) : '';
}

interface Captured {
  type: string;
  payload: Record<string, unknown>;
  eventId?: string;
}

/** A sink that only collects, so events can be queued before anything is sent. */
function captureSink(into: Captured[]): EventSink {
  return {
    emit(type, payload, eventId) {
      into.push(eventId !== undefined ? { type, payload, eventId } : { type, payload });
    },
    async close() {
      /* nothing to flush */
    },
  };
}

/** What the recorder knows about itself, gathered before the lock is taken. */
interface Evidence {
  registered?: string[];
  repoHead?: string;
}

/**
 * Put what the record says about its own completeness on every report, not
 * just the closing one: the server reads the last report it holds, and a
 * record closed by anything but a clean session end never gets a closing one.
 */
function withReportEvidence(
  payload: Record<string, unknown>,
  state: SessionState,
  seq: number,
  drops: { subagentEventsUnattached: number; eventsDroppedBudget: number },
  phaseHead: string | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload, collector: 'aer-hooks', version: HOOKS_VERSION };
  if (state.eventsRegistered !== undefined && state.eventsRegistered.length > 0) out['events_registered'] = state.eventsRegistered;
  out['events_emitted'] = seq - state.segmentStartSeq + 1;
  out['tools_unresolved'] = state.toolsOpen;
  if (drops.subagentEventsUnattached > 0) out['subagent_events_unattached'] = drops.subagentEventsUnattached;
  const droppedBudget = drops.eventsDroppedBudget + state.droppedBudget;
  if (droppedBudget > 0) out['events_dropped_budget'] = droppedBudget;
  if (phaseHead !== undefined) out['repo_head'] = phaseHead;
  return stripToIngestPayload(out).payload;
}

/** Start numbering a new record from the next position. */
function startSegment(state: SessionState, now: number, storeKey: string, env: NodeJS.ProcessEnv): void {
  state.segmentStartSeq = state.seq + 1;
  state.segmentStartedAt = now;
  state.droppedBudget = 0;
  clearDropCounters(storeKey, env);
}

/**
 * Turn one hook event into queued events: the event itself, any model calls
 * the transcript settled since the last read, each numbered in order. The
 * transcript position moves forward only together with the queued events it
 * produced, and they leave the queue only once the server has taken them, so
 * a failed send never loses a model call.
 */
function buildQueuedEvents(
  event: HookEvent,
  state: SessionState,
  now: number,
  evidence: Evidence,
  storeKey: string,
  env: NodeJS.ProcessEnv,
  numbered: boolean,
): OutboxEvent[] {
  const captured: Captured[] = [];
  const sink = captureSink(captured);
  const scan = numbered ? scanTranscriptForLlmUsage(event, transcriptStateOf(state)) : { events: [], state: {} };
  state.toolsOpen = nextToolsOpen(state.toolsOpen, event.kind);
  emitHookEvent(event, sink);
  emitLlmUsageEvents(scan.events, sink, event.sessionRef);
  if (scan.state.transcriptPath !== undefined) state.transcriptPath = scan.state.transcriptPath;
  if (scan.state.transcriptOffset !== undefined) state.transcriptOffset = scan.state.transcriptOffset;
  if (scan.state.emittedLlmMessageIds !== undefined) state.emittedLlmMessageIds = scan.state.emittedLlmMessageIds;

  const drops = readDropCounters(storeKey, env);
  const ts = new Date(now).toISOString();
  return captured.map((c) => {
    let payload = c.payload;
    let seq: number | undefined;
    if (numbered) {
      seq = ++state.seq;
      payload = { ...payload, seq };
    }
    if (c.type === 'collector.report' && numbered && seq !== undefined) {
      payload = withReportEvidence(payload, state, seq, drops, event.kind === 'session_start' ? evidence.repoHead : undefined);
    } else if (c.type === 'collector.report') {
      const extra: Record<string, unknown> = { ...payload, collector: 'aer-hooks', version: HOOKS_VERSION };
      if (evidence.registered !== undefined && evidence.registered.length > 0) extra['events_registered'] = evidence.registered;
      payload = stripToIngestPayload(extra).payload;
    }
    return { id: c.eventId ?? randomUUID(), type: c.type, ts, payload };
  });
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

// field 22 (starttime, ticks since boot) in /proc/<pid>/stat, after the
// parenthesised comm field which may itself contain spaces/parens.
function startTimeViaProc(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    // fields[0] is state (proc field 3); starttime is proc field 22, so index 22-3=19 here.
    return fields[19];
  } catch {
    return undefined;
  }
}

function startTimeViaPs(pid: number): string | undefined {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 500 }).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** When a process actually started, so a pid alias can detect a recycled pid rather than trust it blindly. */
function defaultProcessStartTime(pid: number): string | undefined {
  return process.platform === 'linux' ? startTimeViaProc(pid) : startTimeViaPs(pid);
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
 * A subagent event with no lead found under its own session id: find the
 * lead's store key by walking up to three ancestor pids and checking each
 * for a SessionStart pid alias. Fail-soft at every step.
 *
 * An alias whose identity (process start time, agent, base URL) disagrees
 * with this invocation's own is refused rather than trusted (a recycled pid,
 * or a different agent/tenant's session). An alias whose store entry is
 * already gone is deleted and skipped, so it never wins over a later pid
 * that carries a live one.
 */
function walkPidAliasForLead(
  env: NodeJS.ProcessEnv,
  now: number,
  base: HttpSinkOptions,
  deps: RunHookDeps,
): string | undefined {
  const ownPpid = deps.ownPpid ?? process.ppid;
  const parentPidOf = deps.parentPidOf ?? defaultParentPidOf;
  const startTimeOf = deps.processStartTime ?? defaultProcessStartTime;
  for (const pid of ancestorPids(ownPpid, 3, parentPidOf)) {
    // Compared against THIS candidate pid's own current start time - the
    // alias claims to be about this exact process, not the reader's.
    const expected = { startTime: startTimeOf(pid), agentId: base.agentId, baseUrl: base.baseUrl };
    const alias = loadPidAlias(String(pid), env, now, expected);
    if (alias === null) continue;
    const lead = loadState(alias, env, now);
    if (lead === null || lead.ended === true) {
      deletePidAlias(String(pid), env);
      continue;
    }
    return alias;
  }
  return undefined;
}

/**
 * Resolve this invocation's store key (ADR-023 B1, revised after review
 * against Claude Code 2.1.281): an explicit `--root-session` override wins
 * outright; otherwise, existing state under the event's OWN session id wins
 * (a subagent's payload already carries the lead's session_id); otherwise
 * the harness-exported root session id; otherwise the event's own id.
 */
function resolveStoreKey(ref: string, env: NodeJS.ProcessEnv, now: number, explicitRoot: string | undefined): string {
  if (explicitRoot !== undefined) return explicitRoot;
  if (loadState(ref, env, now) !== null) return ref;
  const envRoot = rootSessionFromEnv(env);
  if (envRoot !== undefined) return envRoot;
  return ref;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Ctx {
  storeKey: string;
  env: NodeJS.ProcessEnv;
  api: ApiBase;
  clientRef: string;
  /** This invocation's clock: the injected start time plus real elapsed time. */
  clock: () => number;
  deadline: number;
  /** Who holds the network role, unique per invocation even within one process. */
  owner: string;
  /** The last event of the harness session: worth waiting for another invocation to finish. */
  final: boolean;
  isSubagent: boolean;
  ownPpid: number;
  /** The worker a session end left behind: no event follows it. */
  worker?: boolean;
  /** The time a request may take at most, REQUEST_TIMEOUT_MS outside tests. */
  requestTimeoutMs: number;
  warn: (kind: string, message: string) => void;
}

/** What happens to what could not be sent: a later event retries it, but after the worker nothing comes. */
function afterFailure(ctx: Ctx, later: string): string {
  return ctx.worker ? 'the worker gave up for now and the record stays open; a resumed session sends it' : later;
}

function remaining(ctx: Ctx): number {
  return ctx.deadline - ctx.clock();
}

/**
 * Read, change and write this harness session's state under its lock. The
 * lock is never held across anything but local file work. Returns undefined
 * when the lock could not be had.
 */
async function withState<T>(ctx: Ctx, fn: (state: SessionState | null, now: number) => { result: T; save?: SessionState | null }): Promise<T | undefined> {
  const lock = await acquireSessionLock(ctx.storeKey, ctx.env, { maxWaitMs: Math.max(0, Math.min(LOCK_WAIT_MS, remaining(ctx) - MIN_CALL_MS)) });
  if (!lock) return undefined;
  try {
    const now = ctx.clock();
    const out = fn(loadState(ctx.storeKey, ctx.env, now), now);
    if (out.save) saveState(ctx.storeKey, out.save, ctx.env);
    return out.result;
  } finally {
    lock.release();
  }
}

function releaseLease(state: SessionState, ctx: Ctx): void {
  if (state.lease?.owner === ctx.owner) delete state.lease;
}

/** The record is complete: the next events, if any, start a new one under the same client_ref. */
function finishRecord(state: SessionState, mode: 'checkpoint' | 'end', ctx: Ctx, now: number): void {
  delete state.session;
  delete state.complete;
  delete state.openFailures;
  delete state.retryOpenAt;
  startSegment(state, now, ctx.storeKey, ctx.env);
  if (mode === 'end') {
    // The token is gone; what remains is the transcript position, so a
    // resumed harness session never records a model call twice.
    state.ended = true;
    delete state.hostsUnreduced;
    if (!ctx.isSubagent) deletePidAlias(String(ctx.ownPpid), ctx.env);
  }
}

type Step =
  | { kind: 'done' }
  | { kind: 'busy' }
  | { kind: 'open' }
  | { kind: 'post'; session: OpenSession; batch: OutboxEvent[] }
  | { kind: 'complete'; session: OpenSession; mode: 'checkpoint' | 'end' | 'close' };

/** Decide the next network step under the lock, and claim the network role for it. */
function decide(state: SessionState | null, now: number, ctx: Ctx): { result: Step; save?: SessionState | null } {
  if (state === null) return { result: { kind: 'done' } };
  if (state.lease && state.lease.owner !== ctx.owner && state.lease.until > now) return { result: { kind: 'busy' } };

  let step: Step;
  if (state.session?.closeFirst) {
    step = { kind: 'complete', session: state.session, mode: 'close' };
  } else if (state.outbox.length > 0) {
    if (!state.session) {
      if (state.retryOpenAt !== undefined && now < state.retryOpenAt && !ctx.final) {
        releaseLease(state, ctx);
        return { result: { kind: 'done' }, save: state };
      }
      step = { kind: 'open' };
    } else {
      // A batch that already failed is retried one event at a time, so one
      // event the server keeps refusing cannot take its neighbours down too.
      // A batch that ran its full request time without an answer is halved
      // next time: a request too large to finish would otherwise stay at the
      // head of the queue for good, and halving gets through in a few
      // requests where one event at a time could take a hundred.
      const head = state.outbox[0]!;
      const size = (head.attempts ?? 0) >= 2 ? 1 : (state.postLimit ?? POST_BATCH);
      step = { kind: 'post', session: state.session, batch: state.outbox.slice(0, size) };
    }
  } else if (state.complete !== undefined) {
    if (!state.session) {
      // Nothing is open to complete: whatever this record held was already
      // closed by the server, so there is nothing left to do but move on.
      finishRecord(state, state.complete, ctx, now);
      releaseLease(state, ctx);
      return { result: { kind: 'done' }, save: state };
    }
    step = { kind: 'complete', session: state.session, mode: state.complete };
  } else {
    if (state.lease?.owner !== ctx.owner) return { result: { kind: 'done' } };
    releaseLease(state, ctx);
    return { result: { kind: 'done' }, save: state };
  }
  // Whole milliseconds: the deadline can come from performance.timeOrigin,
  // and a lease the store cannot read back is no lease at all.
  state.lease = { owner: ctx.owner, until: Math.ceil(ctx.deadline + LEASE_GRACE_MS) };
  return { result: step, save: state };
}

/**
 * The server closed the record: what is still queued starts the one that
 * replaces it, so that record counts only its own events and its age runs
 * from now. Drops were already reported on the closed record's reports, so
 * the count starts again too.
 */
function replacementSegment(state: SessionState, now: number, ctx: Ctx): void {
  const firstQueued = state.outbox.map((e) => e.payload['seq']).find((n): n is number => typeof n === 'number');
  startSegment(state, now, ctx.storeKey, ctx.env);
  if (firstQueued !== undefined) state.segmentStartSeq = firstQueued;
  // Reports already queued were counted against the closed record.
  for (const e of state.outbox) {
    const seq = e.payload['seq'];
    if (e.type === 'collector.report' && typeof seq === 'number') e.payload['events_emitted'] = seq - state.segmentStartSeq + 1;
  }
}

/**
 * Bring the dropped count on every report still queued up to date. A report
 * built before events were dropped (to make room for it, by the attempts cap,
 * or by a refusal) would otherwise carry a count that is too low, and the
 * closing report is the one the record keeps.
 */
function refreshDropCounts(state: SessionState, storeKey: string, env: NodeJS.ProcessEnv): void {
  const total = readDropCounters(storeKey, env).eventsDroppedBudget + state.droppedBudget;
  if (total <= 0) return;
  for (const e of state.outbox) {
    if (e.type === 'collector.report') e.payload['events_dropped_budget'] = total;
  }
}

/** The report that ends a harness session: it is what completes the record. */
function isClosingReport(e: OutboxEvent): boolean {
  return e.type === 'collector.report' && e.payload['phase'] === 'session_end';
}

/** The session this batch went to is closed or no longer takes this token. */
function sessionGone(r: CallResult): boolean {
  return !r.ok && (r.status === 401 || r.status === 403 || r.status === 404 || r.status === 409);
}

function outcome(r: CallResult): string {
  return r.status === 0 ? 'no answer' : `HTTP ${r.status}`;
}

/**
 * Send what is queued, opening and completing the record as needed, while
 * this invocation has time. One invocation at a time holds the network role;
 * the others queue their events and leave, and the holder picks them up
 * before it lets go. Whatever is still queued when time runs out stays on
 * disk for the next invocation, so nothing depends on this one finishing.
 */
async function deliver(ctx: Ctx): Promise<void> {
  let reopened = false;
  let openRetried = false;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (remaining(ctx) < MIN_CALL_MS + EXIT_MARGIN_MS) break;
    const step = await withState(ctx, (st, now) => decide(st, now, ctx));
    if (step === undefined || step.kind === 'done') return;
    if (step.kind === 'busy') {
      // Another invocation is sending. It takes our events with it, so only
      // the last event of the session waits to see the record through.
      if (!ctx.final) return;
      await sleep(100);
      round--;
      continue;
    }
    const timeoutMs = Math.min(ctx.requestTimeoutMs, remaining(ctx) - EXIT_MARGIN_MS);

    if (step.kind === 'open') {
      const r = await openSession(ctx.api, ctx.clientRef, timeoutMs);
      if ('opened' in r) {
        const opened = r.opened;
        await withState(ctx, (st, now) => {
          if (st === null) return { result: undefined };
          st.session = { id: opened.id, ingestToken: opened.ingestToken, baseUrl: ctx.api.base.baseUrl, openedAt: now };
          delete st.openFailures;
          delete st.retryOpenAt;
          return { result: undefined, save: st };
        });
        continue;
      }
      if (isRetryable(r.failed) && !openRetried && remaining(ctx) > 2 * MIN_CALL_MS + 250) {
        openRetried = true;
        await sleep(250);
        continue;
      }
      await withState(ctx, (st, now) => {
        if (st === null) return { result: undefined };
        const failures = (st.openFailures ?? 0) + 1;
        st.openFailures = failures;
        // The first failure is retried by the very next event; repeated ones back off.
        st.retryOpenAt = failures <= 1 ? now : now + Math.min(OPEN_BACKOFF_MAX_MS, OPEN_BACKOFF_BASE_MS * 2 ** (failures - 2));
        releaseLease(st, ctx);
        return { result: undefined, save: st };
      });
      ctx.warn('open', `aer-hook: could not open the AER session (${outcome(r.failed)}); ${afterFailure(ctx, 'events are queued and will be sent with a later event')}`);
      return;
    }

    if (step.kind === 'post') {
      const r = await postEvents(ctx.api, step.session, step.batch, timeoutMs);
      const ids = new Set(step.batch.map((e) => e.id));
      if (r.ok) {
        await withState(ctx, (st) => {
          if (st === null) return { result: undefined };
          st.outbox = st.outbox.filter((e) => !ids.has(e.id));
          if (st.outbox.length === 0) delete st.postLimit;
          return { result: undefined, save: st };
        });
        continue;
      }
      if (sessionGone(r)) {
        // Closed by the server (a watchdog, a completion elsewhere) or no
        // longer accepting this token: drop it and open again with the same
        // client_ref, which the server has freed, so the queued events land
        // in a new record instead of being refused for a day.
        const again = !reopened;
        reopened = true;
        await withState(ctx, (st, now) => {
          if (st === null) return { result: undefined };
          if (st.session?.id === step.session.id) {
            delete st.session;
            replacementSegment(st, now, ctx);
          }
          if (st.complete === 'checkpoint') delete st.complete;
          if (!again) releaseLease(st, ctx);
          return { result: undefined, save: st };
        });
        if (!again) return;
        continue;
      }
      if (r.status === 413 && r.error === 'session_event_limit_exceeded') {
        await withState(ctx, (st) => {
          if (st === null) return { result: undefined };
          if (st.session?.id === step.session.id) st.session.closeFirst = true;
          return { result: undefined, save: st };
        });
        continue;
      }
      if (!isRetryable(r)) {
        // Refused for good (malformed, too large): drop the batch and count it.
        await withState(ctx, (st) => {
          if (st === null) return { result: undefined };
          const before = st.outbox.length;
          st.outbox = st.outbox.filter((e) => !ids.has(e.id));
          st.droppedBudget += before - st.outbox.length;
          refreshDropCounts(st, ctx.storeKey, ctx.env);
          return { result: undefined, save: st };
        });
        ctx.warn('refused', `aer-hook: the AER API refused ${step.batch.length} event(s) (${outcome(r)}); they were dropped and counted`);
        continue;
      }
      await withState(ctx, (st) => {
        if (st === null) return { result: undefined };
        let dropped = 0;
        // No answer at all (refused, reset, timed out, or this invocation
        // ran out of time) says nothing about the events, so only a status
        // the API actually returned counts toward the cap. The closing report
        // is what completes the record, so the cap never takes it.
        const counts = r.status !== 0;
        st.outbox = st.outbox.filter((e) => {
          if (!ids.has(e.id)) return true;
          if (counts) e.attempts = (e.attempts ?? 0) + 1;
          if ((e.attempts ?? 0) < MAX_SEND_ATTEMPTS || isClosingReport(e)) return true;
          dropped += 1;
          return false;
        });
        st.droppedBudget += dropped;
        if (dropped > 0) refreshDropCounts(st, ctx.storeKey, ctx.env);
        // Only a request that had its whole time says anything about its
        // size; one cut short by this invocation's own deadline does not.
        if (!r.ok && r.timedOut === true && timeoutMs >= ctx.requestTimeoutMs && step.batch.length > 1) {
          st.postLimit = Math.max(1, Math.floor(step.batch.length / 2));
        }
        releaseLease(st, ctx);
        return { result: undefined, save: st };
      });
      ctx.warn('send', `aer-hook: could not send events to AER (${outcome(r)}); ${afterFailure(ctx, 'they stay queued and will be sent with a later event')}`);
      return;
    }

    // complete
    const r = await completeSession(ctx.api, step.session, timeoutMs);
    // Already closed (409), or too large to seal (413): either way this
    // session will take nothing more, so the record moves on.
    if (r.ok || sessionGone(r) || r.status === 413) {
      await withState(ctx, (st, now) => {
        if (st === null) return { result: undefined };
        if (st.session?.id !== step.session.id) return { result: undefined };
        if (step.mode === 'close') delete st.session;
        else finishRecord(st, step.mode, ctx, now);
        return { result: undefined, save: st };
      });
      if (step.mode === 'end') {
        await withState(ctx, (st) => {
          if (st === null) return { result: undefined };
          releaseLease(st, ctx);
          return { result: undefined, save: st };
        });
        return;
      }
      continue;
    }
    await withState(ctx, (st) => {
      if (st === null) return { result: undefined };
      releaseLease(st, ctx);
      return { result: undefined, save: st };
    });
    ctx.warn('complete', `aer-hook: could not complete the AER record (${outcome(r)}); ${afterFailure(ctx, 'a later event will try again')}`);
    return;
  }
  // Out of time: hand the network role back now rather than when it lapses.
  await withState(ctx, (st) => {
    if (st === null) return { result: undefined };
    releaseLease(st, ctx);
    return { result: undefined, save: st };
  });
}

/**
 * With nowhere to keep state, each event is sent on its own: opened with the
 * shared client_ref so the server puts it on the running record, and never
 * numbered, since no position can be kept between invocations. The server
 * allows a limited number of such joins per record.
 */
async function deliverDirect(event: HookEvent, ctx: Ctx, evidence: Evidence, complete: boolean): Promise<void> {
  const state = freshState(ctx.clock());
  const events = buildQueuedEvents(event, state, ctx.clock(), evidence, ctx.storeKey, ctx.env, false);
  if (events.length === 0) return;
  const r = await openSession(ctx.api, ctx.clientRef, Math.min(REQUEST_TIMEOUT_MS, remaining(ctx) - EXIT_MARGIN_MS));
  if (!('opened' in r)) {
    ctx.warn('open', `aer-hook: could not open the AER session (${outcome(r.failed)}); this event was not recorded`);
    return;
  }
  const session = { id: r.opened.id, ingestToken: r.opened.ingestToken };
  for (let i = 0; i < events.length; i += POST_BATCH) {
    await postEvents(ctx.api, session, events.slice(i, i + POST_BATCH), Math.min(REQUEST_TIMEOUT_MS, remaining(ctx) - EXIT_MARGIN_MS));
  }
  if (complete) await completeSession(ctx.api, session, Math.min(REQUEST_TIMEOUT_MS, remaining(ctx) - EXIT_MARGIN_MS));
}

function completes(event: HookEvent): boolean {
  return event.kind === 'session_end';
}

async function orchestrateAndEmit(
  event: HookEvent,
  base: HttpSinkOptions & { sourceType: 'harness'; collector: { name: string; version: string } },
  env: NodeJS.ProcessEnv,
  now: number,
  opts: { rootSession: string | undefined; deadline: number; deps: RunHookDeps; argv: string[]; invokedAt: number },
): Promise<void> {
  const ref = event.sessionRef;
  const isSubagent = isSubagentEvent(event);

  if (!ref) {
    if (isSubagent) {
      const key = typeof event.meta?.['harness_agent_id'] === 'string' ? (event.meta['harness_agent_id'] as string) : 'unknown-subagent';
      noteSubagentEventUnattached(key, env, now);
      return;
    }
    // No correlation id at all: a record of its own, opened and completed here.
    const sink = createHttpSink(base);
    emitHookEvent(event, sink);
    await sink.close();
    return;
  }

  const realStart = Date.now();
  const logged = new Set<string>();
  const log = opts.deps.logError ?? ((m: string) => process.stderr.write(m + '\n'));
  const ctxBase = {
    env,
    api: { base, fetch: base.fetch ?? globalThis.fetch },
    clock: () => now + (Date.now() - realStart),
    deadline: opts.deadline,
    owner: `${process.pid}.${randomBytes(8).toString('hex')}`,
    final: completes(event),
    requestTimeoutMs: opts.deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    isSubagent,
    ownPpid: opts.deps.ownPpid ?? process.ppid,
    warn: (kind: string, message: string) => {
      if (logged.has(kind)) return;
      logged.add(kind);
      try {
        log(message);
      } catch {
        /* a diagnostic must never throw */
      }
    },
  };

  let storeKey = resolveStoreKey(ref, env, now, opts.rootSession);
  const probe = loadState(storeKey, env, now);

  // A subagent never opens a record of its own. With no lead found under the
  // resolved key, the pid-alias walk is the last resort.
  if (isSubagent && (probe === null || probe.ended === true) && stateRoot(env) !== null) {
    const alias = walkPidAliasForLead(env, now, base, opts.deps);
    if (alias === undefined) {
      noteSubagentEventUnattached(storeKey, env, now);
      return;
    }
    storeKey = alias;
  }

  const ctx: Ctx = { ...ctxBase, storeKey, clientRef: deriveClientRef(harnessOf(event), storeKey, base.agentId ?? '') };

  // What the recorder knows about itself is read before the lock, since it
  // touches config files; it is gathered once per harness session.
  const evidence: Evidence = {};
  const harness = harnessOf(event);
  if ((event.kind === 'session_start' || probe === null || probe.eventsRegistered === undefined)
      && (harness === 'claude-code' || harness === 'codex' || harness === 'antigravity')) {
    // The harness's own HOME, which is where its user-level config lives.
    evidence.registered = await registeredEvents(harness, env['HOME'] || undefined, event.cwd);
  }
  if (event.kind === 'session_start') {
    const head = repoHead(event.cwd);
    if (head !== undefined) evidence.repoHead = head;
  }

  if (stateRoot(env) === null) {
    await deliverDirect(event, ctx, evidence, completes(event));
    return;
  }
  // Once per harness session: clear what sessions that never came back left.
  if (event.kind === 'session_start') sweepStale(env);

  const { ageMs, quietMs } = parseCheckpointMs(env);
  const queued = await withState(ctx, (st, at) => {
    let state = st;
    if (state !== null && state.ended === true) {
      if (isSubagent) return { result: 'unattached' as const };
      // The harness session resumed after its record completed.
      delete state.ended;
      startSegment(state, at, ctx.storeKey, env);
    }
    if (state === null) {
      if (isSubagent) return { result: 'unattached' as const };
      state = freshState(at);
    }
    if (evidence.registered !== undefined) state.eventsRegistered = evidence.registered;
    const recordedBefore = state.seq > 0;

    // Back after a quiet period: close the record the quiet period ended,
    // and start this event in a new one. A session end instead joins the
    // record it ends, rather than opening one to hold nothing else.
    if (quietMs > 0 && !completes(event) && state.session !== undefined && at - state.lastActivityAt >= quietMs) {
      state.session.closeFirst = true;
      if (state.complete === 'checkpoint') delete state.complete;
      startSegment(state, at, ctx.storeKey, env);
    }

    const events = buildQueuedEvents(event, state, at, evidence, ctx.storeKey, env, true);
    // The end of a session whose last record a checkpoint already completed:
    // opening a record to hold only this marker would add an empty record to
    // the agent's history. What it would report is on the record that closed.
    if (completes(event) && recordedBefore && state.session === undefined && state.outbox.length === 0
        && events.every((e) => e.type === 'collector.report')) {
      finishRecord(state, 'end', ctx, at);
      state.lastActivityAt = at;
      return { result: 'ended' as const, save: state };
    }
    if (enqueue(state, events) > 0) refreshDropCounts(state, ctx.storeKey, env);
    state.lastActivityAt = at;

    if (completes(event)) {
      state.complete = 'end';
    } else if (event.kind === 'turn_end' && state.complete === undefined
        && ((ageMs > 0 && at - state.segmentStartedAt >= ageMs) || state.seq - state.segmentStartSeq + 1 >= CHECKPOINT_EVENTS)) {
      // A long interactive session may never send its end. Completing at a
      // turn end once the record is old enough gets it sealed and summarised,
      // and the next turn goes on in a new record under the same client_ref.
      state.complete = 'checkpoint';
    }
    return { result: 'queued' as const, save: state };
  });

  if (queued === undefined) {
    noteEventDroppedBudget(storeKey, env, now);
    ctx.warn('lock', 'aer-hook: the record for this harness session stayed locked past the time budget; this event was dropped and counted');
    return;
  }
  if (queued === 'unattached') {
    noteSubagentEventUnattached(storeKey, env, now);
    return;
  }
  if (queued === 'ended') return;

  if (event.kind === 'session_start' && !isSubagent) {
    const startTimeOf = opts.deps.processStartTime ?? defaultProcessStartTime;
    savePidAlias(String(ctx.ownPpid), storeKey, env, now, { startTime: startTimeOf(ctx.ownPpid), agentId: base.agentId, baseUrl: base.baseUrl });
  }

  if (ctx.final) {
    const handedOff = handOffEnd(ctx, event, opts);
    const start = opts.deps.processStart ?? opts.invokedAt;
    const window = endBudgetWindowMs(opts.argv);
    if (handedOff) {
      // The worker reports what it could not send; a line from this hook
      // about a send the worker is about to finish would only mislead. Events
      // the API refused for good are gone before the worker sees the queue,
      // so those are still reported here.
      const warn = ctx.warn;
      ctx.warn = (kind, message) => {
        if (kind === 'refused') warn(kind, message);
      };
    }
    if (window !== undefined) {
      // The entry declares how long the harness allows it, so the hook sends
      // for that long, past its usual timeout, and a record completes even
      // where the worker dies with the harness.
      ctx.deadline = ctx.clock() + (start + window - Date.now());
    } else if (handedOff) {
      // No declared budget: keep to what Claude Code allows an entry with no
      // timeout, and leave the rest to the worker. The lease keeps the two
      // from sending twice.
      ctx.deadline = Math.min(ctx.deadline, ctx.clock() + (start + SESSION_END_INLINE_MS - Date.now()));
    }
  }
  await deliver(ctx);
}

/** The flags the worker needs to rebuild this invocation's view, and nothing secret. */
/**
 * What the worker is told: which harness session to finish, for which
 * harness, and where the credential file is. It reads nothing else; the
 * session is already resolved, so --root-session and --event are not needed.
 * Under a lifecycle v1 registration Stop ends the record, so each turn starts
 * a worker; each finishes in about a second when there is nothing left.
 */
function drainArgvFor(argv: string[], env: NodeJS.ProcessEnv, storeKey: string, harness: string, ownPpid: number): string[] {
  const out: string[] = [];
  // Absolute, so the worker never depends on the hook's working directory,
  // which a temporary checkout may remove as soon as the harness exits.
  const envFile = parseEnvFileFlag(argv) ?? (env['AER_ENV_FILE'] || undefined);
  if (envFile !== undefined) out.push('--env-file', nodePath.resolve(envFile));
  // Each value is joined to its flag, so a session id that itself looks like a
  // flag (the harness chooses it) can never be read as one.
  return [...out, `--drain=${storeKey}`, `--drain-harness=${harness}`, `--harness-pid=${ownPpid}`];
}

function handOffEnd(ctx: Ctx, event: HookEvent, opts: { deps: RunHookDeps; argv: string[] }): boolean {
  const handOff = opts.deps.handOff ?? (opts.deps.fetch !== undefined ? undefined : spawnDrainWorker);
  if (handOff === undefined) return false;
  try {
    return handOff(drainArgvFor(opts.argv, ctx.env, ctx.storeKey, harnessOf(event), ctx.ownPpid));
  } catch {
    return false;
  }
}

/**
 * Start the worker as a grandchild the harness cannot reach: a new session,
 * and a shell that backgrounds it and exits at once, so it is no longer a
 * descendant of the hook when the harness kills the hook's process tree or
 * group. It gets only the variables workerEnv keeps, never the credential
 * file's values, which it reads itself.
 */
const WORKER_ENV_EXACT = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TZ', 'TMPDIR', 'TMP', 'TEMP',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY', 'NODE_USE_SYSTEM_CA', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
]);

/** The NODE_OPTIONS flags that only choose which certificates to trust. */
const CA_FLAGS = new Set(['--use-system-ca', '--use-openssl-ca', '--use-bundled-ca']);

/**
 * The environment the worker gets: what it needs to find its state, its
 * settings and its network. Not the rest of the harness's environment, which
 * can hold model API keys and cloud credentials, and of NODE_OPTIONS only the
 * certificate flags: anything else there could load code into it.
 */
export function workerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (WORKER_ENV_EXACT.has(k) || k.startsWith('AER_') || k.startsWith('XDG_') || k.startsWith('LC_')) out[k] = v;
  }
  const caFlags = (env['NODE_OPTIONS'] ?? '').split(/\s+/).filter((f) => CA_FLAGS.has(f));
  if (caFlags.length > 0) out['NODE_OPTIONS'] = [...new Set(caFlags)].join(' ');
  return out;
}

function spawnDrainWorker(drainArgv: string[]): boolean {
  try {
    const cli = fileURLToPath(import.meta.url);
    const child = spawn('/bin/sh', ['-c', '"$0" "$@" </dev/null >/dev/null 2>&1 &', process.execPath, cli, ...drainArgv], {
      detached: true,
      stdio: 'ignore',
      env: workerEnv(process.env),
      // Not the hook's working directory: the worker must not pin it.
      cwd: '/',
    });
    child.on('error', () => undefined);
    child.unref();
    return child.pid !== undefined;
  } catch {
    return false;
  }
}

/** The value of a `--name=value` flag. Only this form: the worker's values are never separate words. */
function flagValue(argv: string[], name: string): string | undefined {
  const a = argv.find((x) => x.startsWith(`${name}=`));
  return a === undefined ? undefined : a.slice(name.length + 1);
}

/** Append one line to the worker's diagnostics file in the state dir, keeping it small. */
function drainLogger(env: NodeJS.ProcessEnv): (message: string) => void {
  return (message) => {
    try {
      const root = stateRoot(env);
      if (root === null) return;
      const file = nodePath.join(root, 'drain.log');
      let size = 0;
      try { size = fs.lstatSync(file).size; } catch { /* no file yet */ }
      const line = `${new Date().toISOString()} ${message}\n`;
      if (size + line.length > DRAIN_LOG_MAX_BYTES) fs.writeFileSync(file, line, { mode: 0o600 });
      else fs.appendFileSync(file, line, { mode: 0o600 });
    } catch {
      /* a diagnostic must never throw */
    }
  };
}

/**
 * The worker's budget: DRAIN_BUDGET_MS, or less when AER_HOOK_DRAIN_BUDGET_MS
 * (or a test) asks for less. It is never raised: the hard stop is fixed.
 * AER_HOOK_DRAIN_BUDGET_MS exists for tests and is documented only in
 * CONTRIBUTING.
 */
function drainBudget(env: NodeJS.ProcessEnv, deps: RunHookDeps): number {
  const fromEnv = Number(env['AER_HOOK_DRAIN_BUDGET_MS']);
  const asked = deps.drainBudgetMs ?? (Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : DRAIN_BUDGET_MS);
  return Math.min(DRAIN_BUDGET_MS, asked);
}

/**
 * The worker a session end leaves behind: finish sending what is queued for
 * one harness session and complete its record, within a fixed budget, then
 * exit. Nothing waits on it; what it has to say goes to the state dir.
 */
export async function runDrain(argv: string[], env: NodeJS.ProcessEnv = process.env, deps: RunHookDeps = {}): Promise<void> {
  try {
    const storeKey = flagValue(argv, '--drain');
    if (storeKey === undefined || storeKey.length === 0) return;
    const log = deps.logError ?? drainLogger(env);
    env = envWithFile(argv, env, log);
    const base = resolveBase(env, deps, log);
    if (base === null) return;
    const harness = flagValue(argv, '--drain-harness') ?? '';
    const ppid = Number(flagValue(argv, '--harness-pid'));
    const realStart = Date.now();
    const now = (deps.now ?? Date.now)();
    const logged = new Set<string>();
    const ctx: Ctx = {
      storeKey,
      env,
      api: { base, fetch: base.fetch ?? globalThis.fetch },
      clientRef: deriveClientRef(harness, storeKey, base.agentId ?? ''),
      clock: () => now + (Date.now() - realStart),
      deadline: now + drainBudget(env, deps),
      owner: `${process.pid}.${randomBytes(8).toString('hex')}`,
      final: true,
      worker: true,
      requestTimeoutMs: deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      isSubagent: false,
      ownPpid: Number.isInteger(ppid) && ppid > 0 ? ppid : process.ppid,
      warn: (kind, message) => {
        if (logged.has(kind)) return;
        logged.add(kind);
        log(message);
      },
    };
    // A failed open or send backs off rather than giving up at once: this
    // is the last chance the record gets.
    for (const pause of [0, 2000, 5000, 10_000]) {
      if (pause > 0) {
        if (remaining(ctx) < pause + 5000) return;
        await sleep(pause);
      }
      await deliver(ctx);
      const st = loadState(storeKey, env, ctx.clock());
      if (st === null || (st.complete === undefined && st.outbox.length === 0)) return;
    }
  } catch {
    /* a worker nobody waits on still never throws */
  }
}

/** The sink options a hook or its worker records with, or null when unconfigured. */
function resolveBase(env: NodeJS.ProcessEnv, deps: RunHookDeps, log: (m: string) => void) {
  const overrides = deps.fetch ? { fetch: deps.fetch } : {};
  const resolved = resolveSinkOptionsFromEnv(env, overrides);
  // Unconfigured: do nothing, touch no network.
  if (!resolved) return null;
  // The API refuses an open without an environment, so every event would
  // queue for a session that can never open. Say so instead.
  if (resolved.environmentId === undefined || resolved.environmentId.length === 0) {
    try {
      log('aer-hook: AER_ENV_ID is not set; the AER API needs it to open a session, so nothing was recorded');
    } catch {
      /* a diagnostic must never throw */
    }
    return null;
  }
  // A harness records tool lifecycle through hooks and never watches the
  // wire, so mark it as such rather than inherit the wrapper default, which
  // means the auto-node collector did watch it.
  return {
    ...resolved,
    // Required by the API. A harness does not report its own version to
    // its hooks, so without AER_AGENT_VERSION it is recorded as unspecified.
    agentVersion: resolved.agentVersion ?? DEFAULT_AGENT_VERSION,
    sourceType: 'harness' as const,
    // Declare who is recording, so a reader can tell a harness recording
    // from a wrapped process without inferring it from the events.
    collector: { name: 'aer-hooks', version: HOOKS_VERSION },
  };
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
  const invokedAt = Date.now();
  try {
    // Credentials from an owner-only file, for this process alone.
    env = envWithFile(argv, env, deps.logError ?? ((m) => process.stderr.write(m + '\n')));
    const harness = parseHarnessFlag(argv);
    const base = resolveBase(env, deps, deps.logError ?? ((m: string) => process.stderr.write(m + '\n')));
    if (base === null) return;

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
    await orchestrateAndEmit(event, base, env, now, { rootSession, deadline: now + hardTimeoutMs, deps, argv, invokedAt });
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

  // The worker a session end started: no stdin, its own budget, and a hard
  // stop so a worker can never linger.
  if (argv.some((a) => a.startsWith('--drain='))) {
    const stop = setTimeout(() => process.exit(0), DRAIN_HARD_STOP_MS);
    try {
      await runDrain(argv, env, deps);
    } finally {
      clearTimeout(stop);
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

  // The entry that ends a session may declare a longer budget; it is the only
  // one allowed past the usual timeout.
  const window = endBudgetWindowMs(argv);
  const limitMs = window !== undefined ? Math.max(hardTimeoutMs, window) : hardTimeoutMs;
  let timedOut = false;
  const timeout = new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      timedOut = true;
      resolve();
    }, limitMs);
    // Do not keep the event loop alive solely for the timeout.
    if (typeof t.unref === 'function') t.unref();
  });
  try {
    await Promise.race([
      runHook(argv, env, { ...deps, hardTimeoutMs: deps.hardTimeoutMs ?? hardTimeoutMs, processStart: deps.processStart ?? performance.timeOrigin }),
      timeout,
    ]);
  } catch {
    /* fail open */
  }
  if (timedOut) {
    try {
      process.stderr.write(`aer-hook: timed out after ${limitMs}ms; the AER record for this event may be incomplete\n`);
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
