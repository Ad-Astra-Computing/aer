// opencode plugin harness → shared HookEvent.
//
// Unlike Claude Code / Codex (which fire shell hooks passing one JSON payload on
// stdin), opencode loads an in-process JS/TS PLUGIN and calls typed hooks. We map
// those hooks into the same `HookEvent` shape so opencode reuses the identical
// bodies-off emit pipeline (emitHookEvent): tool NAMES + argument KEY names only,
// never values or result content.
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
//       this is where opencode surfaces LLM model + token usage (bodies-off - the
//       message CONTENT lives in separate message.part.updated events we never read).
//
// Native plugin capture beats MCP-only for opencode: it also catches non-MCP
// tools (bash/read/write/edit) the MCP recorder never sees.

import type { HookEvent } from './normalize.js';
import { asRecord, asString, keysOf, responseIsError } from './normalize.js';
import { shapesOfToolCall } from './tool-shape.js';
import { recordableToolName } from './tool-name.js';

/** Marks every opencode event, as the shell hooks mark theirs. */
export const HARNESS_META = { harness: 'opencode' } as const;

/**
 * opencode's built-in tools, and the one argument each reduces by, mapped to
 * the tool the shared reduction already knows. The reduction is the privacy
 * boundary: a command line becomes its program names and hosts, a file tool
 * its path, a fetch its host. Nothing else of the input is passed on.
 *
 * Confirmed against @opencode-ai/{plugin,sdk}@1.18.31 (the pinned release,
 * tag v1.18.31 of the opencode source) built-in tool registry
 * (packages/opencode/src/tool/registry.ts): the full built-in id list there
 * is invalid, question, shell, read, glob, grep, edit, write, task, fetch,
 * todo, search, skill, apply_patch, execute, lsp, plan. Three deliberately
 * have no entry below:
 *   - "task" (glob-of-work spawner, args: description, prompt, subagent_type,
 *     task_id, command, background): `prompt` is the only argument that
 *     makes the event useful, and it is the free-text instructions handed to
 *     the subagent - exactly the shape Claude Code's own equivalent (Task)
 *     also leaves unmapped here. Falls through to the generic {tool,
 *     arg_keys} shape.
 *   - "todo" (wire name "todowrite", args: todos, each a {content, status,
 *     ...} record): `content` is the free-text todo item itself; there is no
 *     reduction of a todo list that is not either empty or a content leak.
 *     Falls through to the generic shape, same as Claude Code's own
 *     TodoWrite.
 *   - "list": does not exist as an opencode built-in at this pinned version
 *     (checked the full registry above) - nothing to map.
 * grep/glob/apply_patch map below because each has an established safe
 * reduction already shipped for another harness's identically-shaped tool:
 * glob/grep mirror Claude Code's own Glob/Grep (GLOB_TOOLS/GREP_TOOLS in
 * tool-shape.ts - path/pattern classification only, never the raw pattern or
 * path), and opencode's "apply_patch" tool uses the exact same "*** Begin
 * Patch"/"*** Add File:"/"*** Update File:"/"*** Delete File:"/"*** Move
 * to:" envelope Codex's own apply_patch uses (confirmed against opencode's
 * apply_patch.ts and apply_patch.txt at the same pinned tag), so it reduces
 * through the same header-only file-path extraction (PATCH_TOOL in
 * tool-shape.ts): the diff body is never read, only each operation's file
 * path.
 */
const SHAPE_ALIASES: Readonly<Record<string, (args: Record<string, unknown>) => [string, Record<string, unknown>]>> = {
  bash: (a) => ['Bash', { command: a['command'] }],
  read: (a) => ['Read', { file_path: a['filePath'] }],
  write: (a) => ['Write', { file_path: a['filePath'] }],
  edit: (a) => ['Edit', { file_path: a['filePath'] }],
  webfetch: (a) => ['WebFetch', { url: a['url'] }],
  glob: (a) => ['Glob', { pattern: a['pattern'], path: a['path'] }],
  grep: (a) => ['Grep', { pattern: a['pattern'], path: a['path'] }],
  // opencode's own tool id, matching PATCH_TOOL in tool-shape.ts exactly; the
  // tool's one argument (`patchText`) is renamed to `command` because that is
  // the field name the shared patch-header reduction reads.
  apply_patch: (a) => ['apply_patch', { command: a['patchText'] }],
};

function putShapes(event: HookEvent, tool: string, args: unknown): void {
  const alias = SHAPE_ALIASES[tool];
  const rec = asRecord(args);
  if (alias === undefined || rec === undefined) return;
  const [name, input] = alias(rec);
  const shapes = shapesOfToolCall(name, input);
  if (shapes.length > 0) {
    event.shape = shapes[0];
    event.shapes = shapes;
  }
}

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
  const event: HookEvent = { kind: 'tool_start', meta: { ...HARNESS_META } };
  const tool = asString(input?.tool);
  if (tool !== undefined) event.tool = recordableToolName(tool);
  const sessionRef = asString(input?.sessionID);
  if (sessionRef !== undefined) event.sessionRef = sessionRef;
  const argKeys = keysOf(output?.args);
  if (argKeys !== undefined) event.argKeys = argKeys;
  if (tool !== undefined) putShapes(event, tool, output?.args);
  return event;
}

/**
 * `tool.execute.after` → tool_end. The after hook fires only on completion, so we
 * default to success; an error is inferred defensively from the freeform tool
 * metadata (opencode surfaces failures either by throwing - no after hook - or in
 * metadata). Result content is never read.
 */
export function normalizeOpencodeToolAfter(
  input: OpencodeToolAfterInput,
  output?: OpencodeToolAfterOutput,
): HookEvent {
  const event: HookEvent = { kind: 'tool_end', meta: { ...HARNESS_META } };
  const tool = asString(input?.tool);
  if (tool !== undefined) event.tool = recordableToolName(tool);
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
 * repeatedly) so it is NOT an end - dropped as `other`. Everything else is `other`.
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
  if (kind !== 'other') out.meta = { ...HARNESS_META };
  if (kind !== 'other' && sessionRef !== undefined) out.sessionRef = sessionRef;
  return out;
}
