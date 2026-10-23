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
import { SHA as SHA_RE } from './evidence.js';
import type { ConfigInternalSnapshot } from './config-snapshot.js';

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
  /** Codex only: read once off session_meta and cached, never re-derived from the model name once set. */
  provider?: string;
  /** Which harness events the installation wires, carried on every report. */
  eventsRegistered?: string[];
  session?: OpenSession;
  /** The invocation currently talking to the server for this harness session. */
  lease?: { owner: string; until: number };
  /** Consecutive failed opens and when the next may be tried. */
  openFailures?: number;
  retryOpenAt?: number;
  /**
   * Set when the AER API refuses with usage_limit_reached or agent_paused
   * (a structured 403, never treated as the session being gone): no further
   * open/post attempts are made for this harness session until this time,
   * so a long run does not hammer the API on every hook invocation while the
   * tenant is over its cap or the agent is paused. Queued events are kept,
   * not dropped: the refusal is expected to clear on its own.
   */
  refusedUntil?: number;
  /** Complete the record once every queued event is accepted. */
  complete?: 'checkpoint' | 'end';
  /** The harness session ended and its record completed; kept only so a transcript is never read twice. */
  ended?: boolean;
  /** Events this record lost to a full queue or a send that kept failing. */
  droppedBudget: number;
  /** Network targets a shell line named that could not be reduced to a host. Local only. */
  hostsUnreduced?: number;
  /**
   * Oversight markers (P0-1): calls PreToolUse opened, not yet closed by
   * tool_end, keyed by tool_use_id. callDigest lets a later PermissionRequest
   * (which drops tool_use_id on this build) be matched back to the call it
   * belongs to by content, never by queue position. Local only: the digest
   * never rides an emitted event.
   */
  openCalls?: Record<string, { callDigest: string; openedAt: number }>;
  /**
   * Open permission requests, oldest first, not yet resolved by a tool_end.
   * Each entry's `id` is a REAL tool_use_id recovered via openCalls, or
   * (only when no open call's digest matches) a synthetic `unid:<n>`;
   * `pushedAt` lets the narrow FIFO fallback require the single open call to
   * have been opened no later than the request itself. Cleared at every
   * turn_end AND session_end: an entry orphaned in one turn must never be
   * resolved by an unrelated call several turns (or sessions) later.
   */
  pendingApprovals?: Array<{ id: string; pushedAt: number }>;
  /** Per-session counter for synthesizing the next `unid:<n>` placeholder. */
  pendingApprovalSeq?: number;
  /**
   * Permission requests this collector could not determine the outcome of:
   * still pending at turn_end, resolved through a path these hooks do not
   * observe, or a resolved entry whose PostToolUseFailure outcome this
   * revision declines to guess at. Denied or unanswered, indistinguishable
   * on this build. Reported once, on the closing collector.report, the same
   * way droppedBudget already accumulates across a session.
   */
  approvalsUnresolved: number;
  /**
   * Effects recording (P0-2): a before-digest sampled at tool_start, waiting
   * for the matching tool_end to pair with. Keyed on `${tool_use_id}::${path}`
   * so one call naming several files (MultiEdit, a Codex patch) stashes each
   * independently. `sha256Before` absent means the file was new at
   * tool_start, not an error. Evicted on match (tool_end) or by TTL
   * (orphaned: the PostToolUse that would have closed it never arrived).
   */
  effectStash?: Record<string, { path: string; sha256Before?: string; stashedAt: number }>;
  /** Stash entries evicted by TTL with no matching tool_end: computed but
   *  lost, reported once on the closing collector.report the same way
   *  droppedBudget already accumulates across a session. */
  effectStashesUnattached?: number;
  /**
   * vcs.pushed (git push outcome + before/after ref): the before_ref sampled
   * at tool_start (a `git rev-parse refs/remotes/<remote>/<branch>` taken
   * before the real push runs), waiting for the matching tool_end, keyed by
   * tool_use_id. Only the before_ref itself is worth carrying forward: the
   * matching tool_end recomputes remote_class/branch_class and the raw
   * remote/branch names fresh from its own tool_input, same as every other
   * shape. Absent (not an error) when the push's branch/remote could not be
   * cleanly resolved at tool_start, or when the rev-parse itself found
   * nothing (a brand-new local branch pushed for the first time has no
   * remote-tracking ref yet). tool_end's reflog fallback is what covers
   * that case, not a stash entry.
   */
  vcsPushStash?: Record<string, { beforeRef?: string; stashedAt: number }>;
  /** vcsPushStash entries evicted by TTL with no matching tool_end: computed
   *  but lost, reported the same way effectStashesUnattached is. */
  vcsPushStashesUnattached?: number;
  /**
   * ConfigChange (Claude Code only): the last snapshot read for each
   * resolved settings path, so the next reload can be diffed against it.
   * Survives across ConfigChange events for the life of the session; never
   * emitted (see config-snapshot.ts's module header).
   */
  configSnapshots?: Record<string, { snapshot: ConfigInternalSnapshot; contentHash: string; storedAt: number }>;
  /** Random per-session salt for configSnapshots' content hash. Generated
   *  once, kept only here, never emitted. */
  configSalt?: string;
  /** Writer attribution (ConfigChange): a PreToolUse of a write tool whose
   *  target resolved to a Claude settings/skills path, keyed by that
   *  resolved path. */
  configWriteToolStash?: Record<string, { at: number }>;
  /** Writer attribution: a PreToolUse of Bash, keyed by tool_use_id so a
   *  still-open call can be told apart from one already closed. `open`
   *  flips to false at tool_end rather than deleting the entry, so the
   *  window-based shell_named/shell_unnamed fallback still has it. */
  configShellStash?: Record<string, { kind: 'shell_named' | 'shell_unnamed'; at: number; open: boolean }>;
  /** Writer attribution: the most recent approval.decided allowed/prompted
   *  marker core.ts already computes for the P0-1 oversight signal. */
  configPromptGrantStash?: { at: number };
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

/** Most entries kept in openCalls or pendingApprovals at once; oldest dropped first. */
export const MAX_APPROVAL_TRACKING_ENTRIES = 64;

/** Most before-digest stash entries kept at once; oldest dropped first (and
 *  counted, same as an orphaned entry past its TTL). */
export const MAX_EFFECT_STASH_ENTRIES = 64;

/** A stash entry outliving several hook-timeout windows with no matching
 *  tool_end is orphaned, not just slow: the hook's own self-cap
 *  (AER_HOOK_TIMEOUT_MS, default 10s) bounds one invocation, so a stash
 *  entry open many times that long never gets a PostToolUse. */
export const EFFECT_STASH_TTL_MS = 5 * 60 * 1000;

/** Most vcs-push before_ref stash entries kept at once; oldest dropped first. */
export const MAX_VCS_PUSH_STASH_ENTRIES = 64;

/** Same reasoning as EFFECT_STASH_TTL_MS: a git push outliving several
 *  hook-timeout windows with no matching tool_end is orphaned. */
export const VCS_PUSH_STASH_TTL_MS = 5 * 60 * 1000;

/** State untouched this long is presumed left by a harness that went away. */
const TTL_MS = 24 * 60 * 60 * 1000;

/** Most settings files tracked per session (user/project/local/managed, a
 *  few skills); oldest dropped first. */
export const MAX_CONFIG_SNAPSHOT_ENTRIES = 16;
/** Most open write-tool/shell writer-attribution stash entries kept at once. */
export const MAX_CONFIG_STASH_ENTRIES = 32;
/** Window from a writer stash to the ConfigChange event it may attribute
 *  (design doc 2.4: about 5x the worst observed reload lag). */
export const CONFIG_CHANGE_WINDOW_MS = 15_000;

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
  return { v: 2, createdAt: now, lastActivityAt: now, seq: 0, segmentStartSeq: 1, segmentStartedAt: now, toolsOpen: 0, droppedBudget: 0, approvalsUnresolved: 0, outbox: [] };
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
// A content digest (toolCallDigest in normalize.ts): lowercase hex, fixed width.
const CALL_DIGEST_RE = /^[0-9a-f]{32}$/;
// A harness-assigned tool_use_id (opaque) or our own synthetic placeholder.
// Bounded the same as every other identifier-shaped field this store holds.
const PENDING_APPROVAL_MAX_LEN = 256;
const isPendingApprovalId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= PENDING_APPROVAL_MAX_LEN;

/**
 * Keep at most MAX_APPROVAL_TRACKING_ENTRIES of a parsed openCalls map,
 * dropping all but the most recently opened when a corrupt or oversized
 * file carries more (defence in depth; saveState already caps this on write).
 */
function validOpenCalls(v: unknown): Record<string, { callDigest: string; openedAt: number }> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const entries: Array<[string, { callDigest: string; openedAt: number }]> = [];
  for (const [id, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!isPendingApprovalId(id)) continue;
    const rec = raw as Record<string, unknown> | null;
    if (typeof rec !== 'object' || rec === null) continue;
    const digest = rec['callDigest'];
    const openedAt = rec['openedAt'];
    if (typeof digest !== 'string' || !CALL_DIGEST_RE.test(digest)) continue;
    if (!isInt(openedAt)) continue;
    entries.push([id, { callDigest: digest, openedAt }]);
  }
  if (entries.length === 0) return undefined;
  entries.sort((a, b) => a[1].openedAt - b[1].openedAt);
  const kept = entries.slice(-MAX_APPROVAL_TRACKING_ENTRIES);
  return Object.fromEntries(kept);
}

// path is bounded like any identifier-shaped field this store holds.
const EFFECT_STASH_PATH_MAX_LEN = 4096;
const EFFECT_STASH_KEY_MAX_LEN = PENDING_APPROVAL_MAX_LEN + 1 + EFFECT_STASH_PATH_MAX_LEN;
const HEX64_RE = /^[0-9a-f]{64}$/;

function validEffectStash(v: unknown): Record<string, { path: string; sha256Before?: string; stashedAt: number }> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const entries: Array<[string, { path: string; sha256Before?: string; stashedAt: number }]> = [];
  for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
    if (key.length === 0 || key.length > EFFECT_STASH_KEY_MAX_LEN) continue;
    const rec = raw as Record<string, unknown> | null;
    if (typeof rec !== 'object' || rec === null) continue;
    const p = rec['path'];
    const stashedAt = rec['stashedAt'];
    if (typeof p !== 'string' || p.length === 0 || p.length > EFFECT_STASH_PATH_MAX_LEN) continue;
    if (!isInt(stashedAt)) continue;
    const sha = rec['sha256Before'];
    const entry: { path: string; sha256Before?: string; stashedAt: number } = { path: p, stashedAt };
    if (typeof sha === 'string' && HEX64_RE.test(sha)) entry.sha256Before = sha;
    entries.push([key, entry]);
  }
  if (entries.length === 0) return undefined;
  entries.sort((a, b) => a[1].stashedAt - b[1].stashedAt);
  return Object.fromEntries(entries.slice(-MAX_EFFECT_STASH_ENTRIES));
}

function validVcsPushStash(v: unknown): Record<string, { beforeRef?: string; stashedAt: number }> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const entries: Array<[string, { beforeRef?: string; stashedAt: number }]> = [];
  for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!isPendingApprovalId(key)) continue;
    const rec = raw as Record<string, unknown> | null;
    if (typeof rec !== 'object' || rec === null) continue;
    const stashedAt = rec['stashedAt'];
    if (!isInt(stashedAt)) continue;
    const entry: { beforeRef?: string; stashedAt: number } = { stashedAt };
    const before = rec['beforeRef'];
    if (typeof before === 'string' && SHA_RE.test(before)) entry.beforeRef = before;
    entries.push([key, entry]);
  }
  if (entries.length === 0) return undefined;
  entries.sort((a, b) => a[1].stashedAt - b[1].stashedAt);
  return Object.fromEntries(entries.slice(-MAX_VCS_PUSH_STASH_ENTRIES));
}

function validPendingApprovals(v: unknown): Array<{ id: string; pushedAt: number }> | undefined {
  if (!Array.isArray(v)) return undefined;
  const kept: Array<{ id: string; pushedAt: number }> = [];
  for (const raw of v) {
    const rec = raw as Record<string, unknown> | null;
    if (typeof rec !== 'object' || rec === null) continue;
    const id = rec['id'];
    const pushedAt = rec['pushedAt'];
    if (!isPendingApprovalId(id) || !isInt(pushedAt)) continue;
    kept.push({ id, pushedAt });
  }
  return kept.length === 0 ? undefined : kept.slice(-MAX_APPROVAL_TRACKING_ENTRIES);
}

// ConfigChange's own stashes/snapshot store are read back leniently: a
// malformed or unrecognised shape is simply dropped (the file is re-read on
// the next ConfigChange, costing one `prior_unknown`), never thrown.
function validConfigSnapshots(v: unknown): SessionState['configSnapshots'] {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const entries: Array<[string, { snapshot: ConfigInternalSnapshot; contentHash: string; storedAt: number }]> = [];
  for (const [p, raw] of Object.entries(v as Record<string, unknown>)) {
    if (p.length === 0 || p.length > EFFECT_STASH_PATH_MAX_LEN) continue;
    const rec = raw as Record<string, unknown> | null;
    if (typeof rec !== 'object' || rec === null) continue;
    const snapshot = rec['snapshot'];
    const contentHash = rec['contentHash'];
    const storedAt = rec['storedAt'];
    if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) continue;
    if (typeof contentHash !== 'string' || !HEX64_RE.test(contentHash)) continue;
    if (!isInt(storedAt)) continue;
    entries.push([p, { snapshot: snapshot as ConfigInternalSnapshot, contentHash, storedAt }]);
  }
  if (entries.length === 0) return undefined;
  entries.sort((a, b) => a[1].storedAt - b[1].storedAt);
  return Object.fromEntries(entries.slice(-MAX_CONFIG_SNAPSHOT_ENTRIES));
}

function validConfigWriteToolStash(v: unknown): SessionState['configWriteToolStash'] {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const entries: Array<[string, { at: number }]> = [];
  for (const [p, raw] of Object.entries(v as Record<string, unknown>)) {
    if (p.length === 0 || p.length > EFFECT_STASH_PATH_MAX_LEN) continue;
    const at = (raw as Record<string, unknown> | null)?.['at'];
    if (!isInt(at)) continue;
    entries.push([p, { at }]);
  }
  if (entries.length === 0) return undefined;
  entries.sort((a, b) => a[1].at - b[1].at);
  return Object.fromEntries(entries.slice(-MAX_CONFIG_STASH_ENTRIES));
}

function validConfigShellStash(v: unknown): SessionState['configShellStash'] {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const entries: Array<[string, { kind: 'shell_named' | 'shell_unnamed'; at: number; open: boolean }]> = [];
  for (const [id, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!isPendingApprovalId(id)) continue;
    const rec = raw as Record<string, unknown> | null;
    if (typeof rec !== 'object' || rec === null) continue;
    const kind = rec['kind'];
    const at = rec['at'];
    if (kind !== 'shell_named' && kind !== 'shell_unnamed') continue;
    if (!isInt(at)) continue;
    entries.push([id, { kind, at, open: rec['open'] === true }]);
  }
  if (entries.length === 0) return undefined;
  entries.sort((a, b) => a[1].at - b[1].at);
  return Object.fromEntries(entries.slice(-MAX_CONFIG_STASH_ENTRIES));
}

function validConfigPromptGrantStash(v: unknown): SessionState['configPromptGrantStash'] {
  const at = (v as Record<string, unknown> | null)?.['at'];
  return isInt(at) ? { at } : undefined;
}

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
  if (isStr(p['provider'])) s.provider = p['provider'];
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
  s.approvalsUnresolved = isInt(p['approvalsUnresolved']) ? p['approvalsUnresolved'] : 0;
  if (isInt(p['hostsUnreduced'])) s.hostsUnreduced = p['hostsUnreduced'];
  const openCalls = validOpenCalls(p['openCalls']);
  if (openCalls !== undefined) s.openCalls = openCalls;
  const pendingApprovals = validPendingApprovals(p['pendingApprovals']);
  if (pendingApprovals !== undefined) s.pendingApprovals = pendingApprovals;
  if (isInt(p['pendingApprovalSeq'])) s.pendingApprovalSeq = p['pendingApprovalSeq'];
  const effectStash = validEffectStash(p['effectStash']);
  if (effectStash !== undefined) s.effectStash = effectStash;
  if (isInt(p['effectStashesUnattached'])) s.effectStashesUnattached = p['effectStashesUnattached'];
  const vcsPushStash = validVcsPushStash(p['vcsPushStash']);
  if (vcsPushStash !== undefined) s.vcsPushStash = vcsPushStash;
  if (isInt(p['vcsPushStashesUnattached'])) s.vcsPushStashesUnattached = p['vcsPushStashesUnattached'];
  if (isStr(p['configSalt'])) s.configSalt = p['configSalt'];
  const configSnapshots = validConfigSnapshots(p['configSnapshots']);
  if (configSnapshots !== undefined) s.configSnapshots = configSnapshots;
  const configWriteToolStash = validConfigWriteToolStash(p['configWriteToolStash']);
  if (configWriteToolStash !== undefined) s.configWriteToolStash = configWriteToolStash;
  const configShellStash = validConfigShellStash(p['configShellStash']);
  if (configShellStash !== undefined) s.configShellStash = configShellStash;
  const configPromptGrantStash = validConfigPromptGrantStash(p['configPromptGrantStash']);
  if (configPromptGrantStash !== undefined) s.configPromptGrantStash = configPromptGrantStash;
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
  if (isInt(p['refusedUntil'])) s.refusedUntil = p['refusedUntil'];
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
  // completes the record. The caller brings the dropped count on the queued
  // reports up to date afterwards.
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

/**
 * Effects recording (P0-2): evict stash entries a PostToolUse never came for
 * (older than ttlMs) or past the cap, counting each in effectStashesUnattached
 * so a before-digest computed and lost is reported, not silently dropped.
 */
export function sweepStaleEffectStash(state: SessionState, now: number, ttlMs: number = EFFECT_STASH_TTL_MS): number {
  const stash = state.effectStash;
  if (stash === undefined) return 0;
  const entries = Object.entries(stash);
  const kept: typeof entries = [];
  let evicted = 0;
  for (const entry of entries) {
    if (now - entry[1].stashedAt > ttlMs) evicted += 1;
    else kept.push(entry);
  }
  kept.sort((a, b) => a[1].stashedAt - b[1].stashedAt);
  const overflow = kept.length - MAX_EFFECT_STASH_ENTRIES;
  const final = overflow > 0 ? kept.slice(overflow) : kept;
  evicted += Math.max(0, overflow);
  if (final.length === 0) delete state.effectStash;
  else state.effectStash = Object.fromEntries(final);
  if (evicted > 0) state.effectStashesUnattached = (state.effectStashesUnattached ?? 0) + evicted;
  return evicted;
}

/**
 * vcs.pushed (git push outcome + before/after ref): evict stash entries a
 * PostToolUse never came for (older than ttlMs) or past the cap, counting
 * each in vcsPushStashesUnattached, mirroring sweepStaleEffectStash exactly.
 */
export function sweepStaleVcsPushStash(state: SessionState, now: number, ttlMs: number = VCS_PUSH_STASH_TTL_MS): number {
  const stash = state.vcsPushStash;
  if (stash === undefined) return 0;
  const entries = Object.entries(stash);
  const kept: typeof entries = [];
  let evicted = 0;
  for (const entry of entries) {
    if (now - entry[1].stashedAt > ttlMs) evicted += 1;
    else kept.push(entry);
  }
  kept.sort((a, b) => a[1].stashedAt - b[1].stashedAt);
  const overflow = kept.length - MAX_VCS_PUSH_STASH_ENTRIES;
  const final = overflow > 0 ? kept.slice(overflow) : kept;
  evicted += Math.max(0, overflow);
  if (final.length === 0) delete state.vcsPushStash;
  else state.vcsPushStash = Object.fromEntries(final);
  if (evicted > 0) state.vcsPushStashesUnattached = (state.vcsPushStashesUnattached ?? 0) + evicted;
  return evicted;
}

// ── ConfigChange: snapshot store + writer-attribution stashes ──────────────

/** The session's content-hash salt, generated once and kept only here. */
export function ensureConfigSalt(state: SessionState): string {
  if (state.configSalt === undefined) state.configSalt = randomBytes(16).toString('hex');
  return state.configSalt;
}

/** Remember the snapshot read for a resolved settings path, replacing
 *  whatever was stored for it before. Capped at MAX_CONFIG_SNAPSHOT_ENTRIES. */
export function storeConfigSnapshot(state: SessionState, resolvedPath: string, snapshot: ConfigInternalSnapshot, contentHash: string, now: number): void {
  const next = { ...(state.configSnapshots ?? {}), [resolvedPath]: { snapshot, contentHash, storedAt: now } };
  const entries = Object.entries(next).sort((a, b) => a[1].storedAt - b[1].storedAt);
  state.configSnapshots = Object.fromEntries(entries.slice(-MAX_CONFIG_SNAPSHOT_ENTRIES));
}

/** PreToolUse of a write tool targeting a Claude settings/skills path. */
export function stashConfigWriteTool(state: SessionState, resolvedPath: string, now: number): void {
  const next = { ...(state.configWriteToolStash ?? {}), [resolvedPath]: { at: now } };
  const entries = Object.entries(next).sort((a, b) => a[1].at - b[1].at);
  state.configWriteToolStash = Object.fromEntries(entries.slice(-MAX_CONFIG_STASH_ENTRIES));
}

/** PreToolUse of Bash: stash it as open, named per whether the (already
 *  discarded) command text mentioned a settings/skills path. */
export function stashConfigShellOpen(state: SessionState, toolUseId: string, named: boolean, now: number): void {
  const next = { ...(state.configShellStash ?? {}), [toolUseId]: { kind: named ? 'shell_named' as const : 'shell_unnamed' as const, at: now, open: true } };
  const entries = Object.entries(next).sort((a, b) => a[1].at - b[1].at);
  state.configShellStash = Object.fromEntries(entries.slice(-MAX_CONFIG_STASH_ENTRIES));
}

/** tool_end for a Bash call: the stash (if any) stays, but is no longer "still open". */
export function closeConfigShell(state: SessionState, toolUseId: string): void {
  const entry = state.configShellStash?.[toolUseId];
  if (entry === undefined) return;
  state.configShellStash = { ...state.configShellStash, [toolUseId]: { ...entry, open: false } };
}

/** approval.decided allowed/prompted: the signal core.ts already computes
 *  for the P0-1 oversight marker, reused here rather than recomputed. */
export function stashConfigPromptGrant(state: SessionState, now: number): void {
  state.configPromptGrantStash = { at: now };
}

export type ConfigWriter = 'write_tool' | 'shell_named' | 'shell_unnamed' | 'prompt_grant' | 'none_observed';

/**
 * Attribution at ConfigChange time, in priority order (design doc 2.4):
 * a write_tool stash whose path equals the resolved file; any still-open
 * Bash call; a shell_named, then shell_unnamed stash within the window;
 * prompt_grant only for a local_settings file whose only delta is
 * allow_added; otherwise none_observed. The matched stash is consumed so it
 * cannot attribute a second reload.
 */
export function resolveConfigWriter(
  state: SessionState,
  resolvedPath: string,
  configSource: string,
  changeLabels: readonly string[],
  now: number,
  windowMs: number = CONFIG_CHANGE_WINDOW_MS,
): ConfigWriter {
  const writeTool = state.configWriteToolStash?.[resolvedPath];
  if (writeTool !== undefined && now - writeTool.at <= windowMs) {
    const { [resolvedPath]: _removed, ...rest } = state.configWriteToolStash ?? {};
    state.configWriteToolStash = rest;
    return 'write_tool';
  }

  // An open stash past VCS_PUSH_STASH_TTL_MS is presumed leaked, not still
  // running; among several fresh open stashes the most recent wins.
  const shellEntries = Object.entries(state.configShellStash ?? {});
  const openCandidates = shellEntries.filter(([, e]) => e.open && now - e.at <= VCS_PUSH_STASH_TTL_MS);
  const stillOpen = openCandidates.length === 0
    ? undefined
    : openCandidates.reduce((latest, candidate) => (candidate[1].at > latest[1].at ? candidate : latest));
  if (stillOpen !== undefined) {
    const [id, entry] = stillOpen;
    const { [id]: _removed, ...rest } = state.configShellStash ?? {};
    state.configShellStash = rest;
    return entry.kind;
  }

  const closedInWindow = shellEntries.filter(([, e]) => !e.open && now - e.at <= windowMs);
  const named = closedInWindow.find(([, e]) => e.kind === 'shell_named');
  if (named !== undefined) {
    const [id] = named;
    const { [id]: _removed, ...rest } = state.configShellStash ?? {};
    state.configShellStash = rest;
    return 'shell_named';
  }
  const unnamed = closedInWindow.find(([, e]) => e.kind === 'shell_unnamed');
  if (unnamed !== undefined) {
    const [id] = unnamed;
    const { [id]: _removed, ...rest } = state.configShellStash ?? {};
    state.configShellStash = rest;
    return 'shell_unnamed';
  }

  const promptGrant = state.configPromptGrantStash;
  if (
    promptGrant !== undefined && now - promptGrant.at <= windowMs &&
    configSource === 'local_settings' && changeLabels.length === 1 && changeLabels[0] === 'allow_added'
  ) {
    delete state.configPromptGrantStash;
    return 'prompt_grant';
  }

  return 'none_observed';
}

/** Evict writer-attribution stash entries past the window (plus a margin)
 *  with no match, mirroring sweepStaleEffectStash's shape. Snapshots
 *  themselves are not TTL'd: they are the baseline for the whole session. */
export function sweepStaleConfigStashes(state: SessionState, now: number, windowMs: number = CONFIG_CHANGE_WINDOW_MS): void {
  const margin = windowMs * 2;
  if (state.configWriteToolStash !== undefined) {
    const kept = Object.entries(state.configWriteToolStash).filter(([, e]) => now - e.at <= margin);
    if (kept.length === 0) delete state.configWriteToolStash;
    else state.configWriteToolStash = Object.fromEntries(kept);
  }
  if (state.configShellStash !== undefined) {
    // An open stash gets VCS_PUSH_STASH_TTL_MS, not an indefinite reprieve.
    const kept = Object.entries(state.configShellStash).filter(([, e]) =>
      e.open ? now - e.at <= VCS_PUSH_STASH_TTL_MS : now - e.at <= margin);
    if (kept.length === 0) delete state.configShellStash;
    else state.configShellStash = Object.fromEntries(kept);
  }
  if (state.configPromptGrantStash !== undefined && now - state.configPromptGrantStash.at > margin) {
    delete state.configPromptGrantStash;
  }
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
