// Normalize a harness hook payload into a single shape.
//
// Claude Code and OpenAI Codex CLI both fire shell hooks that pass a JSON event on
// stdin. Their payloads overlap heavily (both carry `hook_event_name`, `tool_name`,
// `tool_input`, `tool_response`, `session_id`), so one normalizer per harness maps
// them to a common `HookEvent` and one binary can serve both.
//
// Harness docs, fetched 2026-09-21. Read them before changing a mapping:
//   https://code.claude.com/docs/en/hooks
//   https://learn.chatgpt.com/docs/hooks
//   https://antigravity.google/docs/hooks

// Probed against the running CLIs, because the docs and the payloads differ:
// Claude Code sends no model on any event and no CLAUDE_MODEL, but it does
// send an undocumented prompt_id that groups a turn the way Codex's turn_id
// does.

// Claude Code and Codex name the event in the payload; Antigravity does not,
// so its registrations pass the name on argv. Antigravity is also camelCase,
// nests the tool call, has no tool-call id and sends no tool response.

// REDACTION ALWAYS: we surface tool names and argument KEY names
// (Object.keys of tool_input/arguments) and never argument values. There is no
// opt-in. The ingest allowlist has never stored an argument-value key, so the
// old AER_HOOK_RECORD_ARGS flag put raw arguments on the wire and recorded
// nothing; see shared/ingest-allowlist.ts.

import { createHash } from 'node:crypto';
import { shapesOfToolCall, patchFileCount, PATCH_FILE_CAP, type ToolShape } from './tool-shape.js';

export type HookKind =
  | 'session_start'
  | 'session_end'
  | 'turn_start'
  | 'turn_end'
  | 'subagent_start'
  | 'subagent_end'
  | 'tool_start'
  | 'tool_end'
  | 'permission'
  | 'compact'
  | 'other';

export interface HookEvent {
  kind: HookKind;
  tool?: string | undefined;
  argKeys?: string[] | undefined;
  ok?: boolean | undefined;
  isError?: boolean | undefined;
  /**
   * Oversight markers (P0-1, build-review fix 1): which hook actually closed
   * this call, set only on `tool_end`. `isError` reflects the TOOL'S outcome
   * (ran, then failed) and is NOT a safe proxy for "the approval could not be
   * resolved" — a PostToolUse with an error-shaped response still means the
   * gate was passed. Only a genuine PostToolUseFailure invocation is the
   * unprobed, possibly-a-denial shape the oversight hedge is for.
   */
  toolEndHook?: 'completed' | 'failure' | undefined;
  sessionRef?: string | undefined;
  /**
   * Position of this event within its harness session, assigned by the
   * session store so a reader can tell a gap from a quiet stretch. Absent
   * when the run could not be correlated and the event stands alone.
   */
  seq?: number | undefined;
  /**
   * What the call reduces to, when the shape is one we recognise: the
   * program a shell call ran, the host a fetch reached, the file a read
   * touched. Computed here so the raw tool input never leaves this module.
   */
  shape?: ToolShape | undefined;
  /**
   * Every shape the call reduces to, in order, `shape` being the first: a
   * shell line runs several programs and can name several hosts.
   */
  shapes?: ToolShape[] | undefined;
  /**
   * How many distinct files a patch named, set only when that is more than
   * were recorded as file.written, so the record says it is incomplete.
   */
  filesNamed?: number | undefined;
  /**
   * The harness's working directory. Used to locate the repository and the
   * project's own config layer, and never emitted: ingest drops it, and it
   * would repeat on every event what a recorded file path already carries.
   */
  cwd?: string | undefined;
  /**
   * Claude Code's `transcript_path`: the JSONL transcript file for this
   * harness session. Used ONLY to locate model + token counts for
   * llm.completed (see claude-code-transcript.ts) - never emitted itself,
   * and never read for anything but `message.model` / `message.usage`.
   */
  transcriptPath?: string | undefined;
  /**
   * Harness metadata for the emitted payload. Only identifier-shaped values
   * that the ingest allowlist stores ever land here; see `identifier`.
   */
  meta?: Record<string, unknown> | undefined;
  /**
   * Oversight markers (P0-1), local correlation only: a content digest over
   * this call's tool_name + tool_input, set on `tool_start` (to record in
   * openCalls) and `permission` (to match PermissionRequest back to the
   * open call it belongs to by content, since this harness build drops
   * tool_use_id from that payload). Computed from the raw tool_input this
   * module already holds in full; NEVER placed on an emitted payload, and
   * no raw tool_input value is ever exposed outside this function.
   */
  callDigest?: string | undefined;
  /**
   * Effects recording (P0-2): the combined before/after file.written shape
   * (or shapes, for a multi-file call) the tool_use_id stash pairing
   * produced at tool_end. Distinct from `shapes`, which already carries
   * this call's ORDINARY shapes at both tool_start and tool_end but is only
   * ever sent at tool_start — core.ts's tool_end case sends only this field,
   * never `shapes`, so a write is never double-reported.
   */
  effectShapes?: ToolShape[] | undefined;
  /**
   * Which permission hook fired, for `kind === 'permission'` only.
   * `PermissionDenied` is specified from the harness docs and has never
   * been observed firing on a live probe (see core.ts's correlation
   * comments); `PermissionRequest` is the probed, common case.
   */
  permissionHook?: 'request' | 'denied' | undefined;
}

export type Harness = 'claude-code' | 'codex' | 'antigravity';

/**
 * Which lifecycle registration wrote the hook entry that invoked us.
 *
 * Version 1 registered `Stop` as the end of the run, because `SessionEnd` was
 * not registered at all. Version 2 registers both and `Stop` becomes the turn
 * marker it actually is. The installer stamps `--lifecycle v2` on the command
 * it writes, so an installation from before this change keeps completing its
 * record on `Stop` instead of never completing one.
 */
export type Lifecycle = 1 | 2;

export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

export function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * A harness metadata value we are willing to put in a signed record.
 *
 * Fields like `reason` and `terminationReason` are documented as labels but
 * nothing stops a harness putting a sentence, a path or command output in one.
 * An identifier shape is the difference between recording a closed-set marker
 * and recording whatever text the harness had to hand, so anything else is
 * dropped rather than trimmed.
 */
export function identifier(v: unknown, maxLength = 128): string | undefined {
  const s = asString(v);
  if (s === undefined || s.length > maxLength) return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]*$/.test(s) ? s : undefined;
}

/** Redaction-safe: the sorted key names of a tool-input/arguments object, never values. */
export function keysOf(v: unknown): string[] | undefined {
  const rec = asRecord(v);
  if (!rec) return undefined;
  return Object.keys(rec).sort();
}

function put(meta: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) meta[key] = value;
}

/** Deterministic JSON serialisation: object keys sorted, array order kept. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const rec = v as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(',')}}`;
}

/**
 * Local-only content digest correlating a PreToolUse call with the
 * PermissionRequest that immediately follows it (same tool_name + tool_input,
 * byte for byte, per the probe log): sha256 of the name, a NUL separator and
 * canonical JSON of the input, truncated to 16 bytes. Computed and consumed
 * entirely inside this process and the 0600 state file; never placed on an
 * emitted payload, and the raw tool_input itself never leaves this function.
 */
export function toolCallDigest(toolName: string, toolInput: unknown): string {
  return createHash('sha256')
    .update(toolName)
    .update('\u0000')
    .update(stableStringify(toolInput ?? null))
    .digest('hex')
    .slice(0, 32);
}

/** Set callDigest from raw tool_name/tool_input when a name is present. Raw values never escape this call. */
function putCallDigest(event: HookEvent, tool: unknown, args: unknown): void {
  const name = asString(tool);
  if (name !== undefined) event.callDigest = toolCallDigest(name, args);
}

/**
 * The kinds shared by Claude Code and Codex, which name their events the same
 * way. `Stop` is the one that depends on how the hook was registered.
 */
function kindFromEventName(name: string, lifecycle: Lifecycle): HookKind {
  switch (name) {
    case 'SessionStart':
      return 'session_start';
    case 'SessionEnd':
      return 'session_end';
    case 'UserPromptSubmit':
      return 'turn_start';
    case 'Stop':
      // Fires once per assistant turn, not once per session. Completing the
      // record here is what split one conversation across several AERs.
      return lifecycle === 2 ? 'turn_end' : 'session_end';
    case 'SubagentStart':
      return 'subagent_start';
    case 'SubagentStop':
      return 'subagent_end';
    case 'PreToolUse':
      return 'tool_start';
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return 'tool_end';
    case 'PermissionDenied':
    case 'PermissionRequest':
      return 'permission';
    case 'PreCompact':
    case 'PostCompact':
      return 'compact';
    default:
      return 'other';
  }
}

// A tool_response can report an error in a few shapes across versions. Read them
// defensively; absence means "no error signalled".
export function responseIsError(resp: unknown): boolean | undefined {
  const rec = asRecord(resp);
  if (!rec) return undefined;
  const flag = rec['is_error'] ?? rec['isError'] ?? rec['error'];
  if (typeof flag === 'boolean') return flag;
  if (flag !== undefined && flag !== null) return true;
  return undefined;
}

/** The metadata Claude Code and Codex both put on every event. */
function commonMeta(p: Record<string, unknown>, harness: Harness, kind: HookKind): Record<string, unknown> {
  const meta: Record<string, unknown> = { harness };
  put(meta, 'model', identifier(p['model']));
  put(meta, 'permission_mode', identifier(p['permission_mode']));
  // Codex calls it turn_id; Claude Code sends prompt_id and documents
  // neither. One name, so a reader does not need to know which harness ran.
  put(meta, 'turn_id', identifier(p['turn_id'] ?? p['prompt_id']));
  if (kind === 'session_start') put(meta, 'source', identifier(p['source']));
  if (kind === 'session_end' || kind === 'permission' || kind === 'compact') {
    // PreCompact names it `trigger`; both are the same closed-set label.
    put(meta, 'reason', identifier(p['reason'] ?? p['trigger']));
  }
  // The harness's own subagent id/type, read on every event (not just the
  // subagent lifecycle markers): a tool call fired inside a subagent carries
  // it too, and that is what lets a reader put the call in its lane. An
  // agent_type with no agent_id is the main thread running under a named
  // mode, not a lane of its own.
  put(meta, 'harness_agent_id', identifier(p['agent_id'], 128));
  put(meta, 'agent_type', identifier(p['agent_type'], 64));
  // No harness documents this today. Recorded only where one sends it: it is
  // what attributes a subagent's work back to the call that spawned it.
  put(meta, 'parent_tool_use_id', identifier(p['parent_tool_use_id']));
  // `permission` is included so a harness that DOES carry tool_use_id on
  // PermissionRequest/PermissionDenied (Codex, per its docs; possibly a
  // future Claude Code build) has it captured. On this Claude Code build the
  // field is absent here (see the probe log), which is why core.ts's
  // identity-first digest match exists: this extension fixes the pipe but is
  // not what carries correlation for Claude Code today.
  if (kind === 'tool_start' || kind === 'tool_end' || kind === 'permission') {
    put(meta, 'tool_use_id', identifier(p['tool_use_id']));
    if (typeof p['duration_ms'] === 'number') meta['duration_ms'] = p['duration_ms'];
  }
  return meta;
}

/** 'PermissionRequest' | 'PermissionDenied' -> HookEvent.permissionHook, for kind === 'permission' only. */
function permissionHookOf(eventName: string): 'request' | 'denied' | undefined {
  if (eventName === 'PermissionRequest') return 'request';
  if (eventName === 'PermissionDenied') return 'denied';
  return undefined;
}

/** Tool name plus argument key names, never argument values. */
function putToolFields(event: HookEvent, tool: unknown, args: unknown): void {
  const name = asString(tool);
  if (name !== undefined) event.tool = name;
  const argKeys = keysOf(args);
  if (argKeys !== undefined) event.argKeys = argKeys;
  if (name !== undefined) {
    // The working directory resolves a relative path a patch names.
    const shapes = shapesOfToolCall(name, args, { cwd: event.cwd });
    if (shapes.length > 0) {
      event.shape = shapes[0];
      event.shapes = shapes;
    }
    if (name === 'apply_patch' && shapes.length >= PATCH_FILE_CAP) {
      const named = patchFileCount(args);
      if (named > shapes.length) event.filesNamed = named;
    }
  }
}

function putOutcome(event: HookEvent, isError: boolean | undefined): void {
  if (isError === undefined) return;
  event.isError = isError;
  event.ok = !isError;
}

/**
 * Map a Claude Code hook payload to a HookEvent. Reads the common fields
 * defensively so an unexpected or partial payload still yields a usable event.
 */
export function normalizeClaudeCode(payload: unknown, lifecycle: Lifecycle = 1): HookEvent {
  const p = asRecord(payload) ?? {};
  const eventName = asString(p['hook_event_name']) ?? '';
  const kind = kindFromEventName(eventName, lifecycle);
  const event: HookEvent = { kind };

  const sessionRef = asString(p['session_id']);
  if (sessionRef !== undefined) event.sessionRef = sessionRef;

  const cwd = asString(p['cwd']);
  if (cwd !== undefined) event.cwd = cwd;
  // Not identifier()-restricted: this is a local filesystem path used only to
  // open the transcript for reading, never put on the wire.
  const transcriptPath = asString(p['transcript_path']);
  if (transcriptPath !== undefined) event.transcriptPath = transcriptPath;
  const meta = commonMeta(p, 'claude-code', kind);
  // Reasoning effort is a Claude Code field and rides in a nested object. It
  // is recorded wherever it appears rather than held back because the other
  // harnesses have no equivalent.
  put(meta, 'effort', identifier(asRecord(p['effort'])?.['level']));
  event.meta = meta;

  if (kind === 'tool_start' || kind === 'tool_end') {
    putToolFields(event, p['tool_name'], p['tool_input']);
  }
  if (kind === 'tool_start') putCallDigest(event, p['tool_name'], p['tool_input']);
  if (kind === 'permission') {
    event.permissionHook = permissionHookOf(eventName);
    putCallDigest(event, p['tool_name'], p['tool_input']);
  }

  if (kind === 'tool_end') {
    if (eventName === 'PostToolUseFailure') {
      // A dedicated failure event is the outcome; its `error` text is not read.
      putOutcome(event, true);
      event.toolEndHook = 'failure';
    } else {
      const isError = responseIsError(p['tool_response']);
      // A response with no error signal is treated as success.
      putOutcome(event, isError ?? (p['tool_response'] !== undefined ? false : undefined));
      event.toolEndHook = 'completed';
    }
  }

  return event;
}

/**
 * Map an OpenAI Codex CLI hook payload to a HookEvent. Codex uses the same field
 * names as Claude Code for tool events, so this shares the mapping logic; it is a
 * distinct entry point so harness-specific fields can diverge without churn.
 */
export function normalizeCodex(payload: unknown, lifecycle: Lifecycle = 1): HookEvent {
  const p = asRecord(payload) ?? {};
  const eventName = asString(p['hook_event_name']) ?? '';
  const kind = kindFromEventName(eventName, lifecycle);
  const event: HookEvent = { kind };

  const sessionRef = asString(p['session_id']);
  if (sessionRef !== undefined) event.sessionRef = sessionRef;
  const cwd = asString(p['cwd']);
  if (cwd !== undefined) event.cwd = cwd;
  event.meta = commonMeta(p, 'codex', kind);

  if (kind === 'tool_start' || kind === 'tool_end') {
    // Codex additionally may carry tool args under `arguments` for some tools;
    // prefer tool_input and fall back to arguments.
    putToolFields(event, p['tool_name'], p['tool_input'] !== undefined ? p['tool_input'] : p['arguments']);
  }
  if (kind === 'tool_start') putCallDigest(event, p['tool_name'], p['tool_input'] !== undefined ? p['tool_input'] : p['arguments']);
  if (kind === 'permission') {
    event.permissionHook = permissionHookOf(eventName);
    putCallDigest(event, p['tool_name'], p['tool_input'] !== undefined ? p['tool_input'] : p['arguments']);
  }

  if (kind === 'tool_end') {
    if (eventName === 'PostToolUseFailure') {
      putOutcome(event, true);
      event.toolEndHook = 'failure';
    } else {
      const isError = responseIsError(p['tool_response']);
      putOutcome(event, isError ?? (p['tool_response'] !== undefined ? false : undefined));
      event.toolEndHook = 'completed';
    }
  }

  return event;
}

/**
 * Map an Antigravity hook payload to a HookEvent.
 *
 * The event name is a parameter because Antigravity does not put it in the
 * payload, unlike the other two harnesses; each registration passes it on argv.
 * Fields are camelCase and the tool call is nested, so none of the Claude Code
 * mapping is reusable.
 */
export function normalizeAntigravity(payload: unknown, eventName: string): HookEvent {
  const p = asRecord(payload) ?? {};
  const kind = antigravityKind(eventName, p);
  const event: HookEvent = { kind };

  // conversationId is the only stable identifier across a run; there is no
  // session_id.
  const sessionRef = asString(p['conversationId']);
  if (sessionRef !== undefined) event.sessionRef = sessionRef;

  // Antigravity gives a list of workspace roots rather than one directory.
  const roots = p['workspacePaths'];
  const cwd = Array.isArray(roots) ? asString(roots[0]) : undefined;
  if (cwd !== undefined) event.cwd = cwd;
  const meta: Record<string, unknown> = { harness: 'antigravity' };
  put(meta, 'model', identifier(p['modelName']));
  if (kind === 'session_end' || kind === 'turn_end') {
    put(meta, 'reason', identifier(p['terminationReason']));
  }
  event.meta = meta;

  if (kind === 'tool_start' || kind === 'tool_end') {
    const call = asRecord(p['toolCall']) ?? {};
    putToolFields(event, call['name'], call['args']);
  }

  if (kind === 'tool_end') {
    // PostToolUse reports failure as a top-level error STRING. Its text can
    // quote command output, so only its presence is recorded.
    putOutcome(event, asString(p['error']) !== undefined);
  }

  return event;
}

/**
 * Antigravity has no SessionStart and its Stop is not always terminal, so the
 * session boundaries are derived rather than named.
 */
function antigravityKind(eventName: string, p: Record<string, unknown>): HookKind {
  switch (eventName) {
    case 'PreToolUse':
      return 'tool_start';
    case 'PostToolUse':
      return 'tool_end';
    case 'PreInvocation': {
      // Fires every turn, and the count is ZERO based: a real run sends 0
      // then 1. Only the first opens the session. A missing count is treated
      // as the first, because opening a session twice is recoverable and
      // never opening it loses the run.
      const n = p['invocationNum'];
      return typeof n !== 'number' || n <= 0 ? 'session_start' : 'turn_start';
    }
    case 'PostInvocation':
      return 'turn_end';
    case 'Stop': {
      // Also fires on non-final terminations. A session left open never
      // produces an AER, so an absent flag closes.
      return p['fullyIdle'] === false ? 'turn_end' : 'session_end';
    }
    default:
      return 'other';
  }
}

/**
 * Pick the harness from the payload shape. Codex tool/turn events carry `turn_id`
 * or `tool_use_id`, which Claude Code does not; a bare `hook_event_name` without
 * those is Claude Code. Callers may override with an explicit harness.
 */
export function detectHarness(payload: unknown): Harness {
  const p = asRecord(payload) ?? {};
  // Antigravity is the only one of the three that omits hook_event_name, and
  // conversationId is on every one of its payloads.
  if (p['hook_event_name'] === undefined && asString(p['conversationId']) !== undefined) {
    return 'antigravity';
  }
  if (asString(p['turn_id']) !== undefined || asString(p['tool_use_id']) !== undefined) {
    return 'codex';
  }
  return 'claude-code';
}

/** Normalize with an explicit or auto-detected harness. */
export function normalize(
  payload: unknown,
  harness?: Harness,
  eventName?: string,
  lifecycle: Lifecycle = 1,
): HookEvent {
  const h = harness ?? detectHarness(payload);
  if (h === 'antigravity') return normalizeAntigravity(payload, eventName ?? '');
  return h === 'codex' ? normalizeCodex(payload, lifecycle) : normalizeClaudeCode(payload, lifecycle);
}
