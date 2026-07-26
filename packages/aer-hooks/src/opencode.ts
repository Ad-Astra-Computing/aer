// opencode plugin harness → shared HookEvent.
//
// Unlike Claude Code / Codex (which fire shell hooks passing one JSON payload on
// stdin), opencode loads an in-process JS/TS PLUGIN and calls typed hooks. We map
// those hooks into the same `HookEvent` shape so opencode reuses the identical
// bodies-off emit pipeline (emitHookEvent): tool NAMES + argument KEY names only,
// never values or result content, unless the operator sets AER_HOOK_RECORD_ARGS.
//
// Hook shapes are from @opencode-ai/plugin (Hooks) + @opencode-ai/sdk (Event),
// pinned 2026-07-17:
//   "tool.execute.before"(input:{tool,sessionID,callID}, output:{args})
//   "tool.execute.after"(input:{tool,sessionID,callID,args}, output:{title,output,metadata})
//   event({event}) where event.type is a discriminator, e.g.
//     session.created { properties:{ info:{ id } } }
//     session.deleted { properties:{ info:{ id } } }
//     session.idle    { properties:{ sessionID } }   ← a turn boundary, not an end
//     message.updated { properties:{ info: Message } } ← assistant Message carries
//       modelID / providerID / tokens{input,output,...} / time.completed / error;
//       this is where opencode surfaces LLM model + token usage (bodies-off — the
//       message CONTENT lives in separate message.part.updated events we never read).
//
// Native plugin capture beats MCP-only for opencode: it also catches non-MCP
// tools (bash/read/write/edit) the MCP recorder never sees.

import type { HookEvent } from './normalize.js';
import { asRecord, asString, keysOf, responseIsError } from './normalize.js';

/** Non-negative finite number, else undefined. Token counts must be well-formed. */
function numOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** LLM metadata lifted from an assistant `message.updated`, bodies-off. */
export interface OpencodeLlm {
  sessionRef?: string;
  /** Assistant message id; the same message updates many times, so use it to dedupe. */
  messageId: string;
  model?: string;
  provider?: string;
  /** false only when the assistant message carried an error. */
  ok: boolean;
  inputTokens?: number;
  outputTokens?: number;
  /** The message reached a terminal state (completed, errored or has a finish reason). */
  complete: boolean;
}

/**
 * A `message.updated` event → LLM metadata for an ASSISTANT message, or null when
 * the event is not an assistant message.updated. Bodies-off: only model/provider,
 * token COUNTS and completion state are read, never the message parts or content.
 * The same assistant message updates repeatedly as it streams, so `messageId` lets
 * the caller emit llm.requested once (first sighting) and llm.completed once (done).
 */
export function normalizeOpencodeMessage(event: unknown): OpencodeLlm | null {
  const e = asRecord(event);
  if (asString(e?.['type']) !== 'message.updated') return null;
  const info = asRecord(asRecord(e?.['properties'])?.['info']);
  if (!info || asString(info['role']) !== 'assistant') return null;
  const messageId = asString(info['id']);
  if (messageId === undefined) return null;

  const errored = info['error'] !== undefined && info['error'] !== null;
  const out: OpencodeLlm = { messageId, ok: !errored, complete: false };
  const sessionRef = asString(info['sessionID']);
  if (sessionRef !== undefined) out.sessionRef = sessionRef;
  const model = asString(info['modelID']);
  if (model !== undefined) out.model = model;
  const provider = asString(info['providerID']);
  if (provider !== undefined) out.provider = provider;

  const tokens = asRecord(info['tokens']);
  const it = numOf(tokens?.['input']);
  if (it !== undefined) out.inputTokens = it;
  const ot = numOf(tokens?.['output']);
  if (ot !== undefined) out.outputTokens = ot;

  // Terminal when opencode stamps time.completed, on error, or a finish reason set.
  const completedAt = numOf(asRecord(info['time'])?.['completed']);
  out.complete = completedAt !== undefined || errored || asString(info['finish']) !== undefined;
  return out;
}

export interface OpencodeToolBeforeInput {
  tool?: string;
  sessionID?: string;
  callID?: string;
}
export interface OpencodeToolBeforeOutput {
  args?: unknown;
}
export interface OpencodeToolAfterInput {
  tool?: string;
  sessionID?: string;
  callID?: string;
  args?: unknown;
}
export interface OpencodeToolAfterOutput {
  title?: string;
  output?: string;
  metadata?: unknown;
}

/** `tool.execute.before` → tool_start. Only the tool name + arg KEY names. */
export function normalizeOpencodeToolBefore(
  input: OpencodeToolBeforeInput,
  output: OpencodeToolBeforeOutput,
): HookEvent {
  const event: HookEvent = { kind: 'tool_start' };
  const tool = asString(input?.tool);
  if (tool !== undefined) event.tool = tool;
  const sessionRef = asString(input?.sessionID);
  if (sessionRef !== undefined) event.sessionRef = sessionRef;
  const argKeys = keysOf(output?.args);
  if (argKeys !== undefined) event.argKeys = argKeys;
  return event;
}

/**
 * `tool.execute.after` → tool_end. The after hook fires only on completion, so we
 * default to success; an error is inferred defensively from the freeform tool
 * metadata (opencode surfaces failures either by throwing — no after hook — or in
 * metadata). Result content is never read.
 */
export function normalizeOpencodeToolAfter(
  input: OpencodeToolAfterInput,
  output?: OpencodeToolAfterOutput,
): HookEvent {
  const event: HookEvent = { kind: 'tool_end' };
  const tool = asString(input?.tool);
  if (tool !== undefined) event.tool = tool;
  const sessionRef = asString(input?.sessionID);
  if (sessionRef !== undefined) event.sessionRef = sessionRef;
  const argKeys = keysOf(input?.args);
  if (argKeys !== undefined) event.argKeys = argKeys;
  const isError = responseIsError(output?.metadata);
  event.isError = isError === true;
  event.ok = isError !== true;
  return event;
}

/**
 * An opencode `event({event})` → HookEvent. Only session lifecycle maps: created →
 * session_start, deleted → session_end. session.idle is a per-turn boundary (fires
 * repeatedly) so it is NOT an end — dropped as `other`. Everything else is `other`.
 */
export function normalizeOpencodeEvent(event: unknown): HookEvent {
  const e = asRecord(event);
  const type = asString(e?.['type']) ?? '';
  const props = asRecord(e?.['properties']);
  // sessionID may live directly on properties (idle) or under properties.info.id
  // (created/deleted). Read both defensively.
  const info = asRecord(props?.['info']);
  const sessionRef = asString(props?.['sessionID']) ?? asString(info?.['id']);

  const kind: HookEvent['kind'] =
    type === 'session.created' ? 'session_start'
      : type === 'session.deleted' ? 'session_end'
        : 'other';

  const out: HookEvent = { kind };
  if (kind !== 'other' && sessionRef !== undefined) out.sessionRef = sessionRef;
  return out;
}
