// Normalize a harness hook payload into a single shape.
//
// Claude Code and OpenAI Codex CLI both fire shell hooks that pass a JSON event on
// stdin. Their payloads overlap heavily (both carry `hook_event_name`, `tool_name`,
// `tool_input`, `tool_response`, `session_id`), so one normalizer per harness maps
// them to a common `HookEvent` and one binary can serve both.
//
// Payload fields mapped, from the harness docs (fetched 2026-07-13):
//   Claude Code - https://code.claude.com/docs/en/hooks
//     PreToolUse:  { session_id, hook_event_name:'PreToolUse',  tool_name, tool_input, cwd, ... }
//     PostToolUse: { session_id, hook_event_name:'PostToolUse', tool_name, tool_input, tool_response, ... }
//     SessionStart:{ session_id, hook_event_name:'SessionStart', source, ... }
//     Stop:        { session_id, hook_event_name:'Stop', last_assistant_message, ... }
//     UserPromptSubmit: { session_id, hook_event_name:'UserPromptSubmit', prompt, ... }
//   Codex CLI - https://learn.chatgpt.com/docs/hooks (redirect from developers.openai.com/codex/hooks)
//     Same hook_event_name set plus SubagentStart/Stop, PreCompact/PostCompact,
//     PermissionRequest. Distinguishing fields: turn_id (turn-scoped events),
//     tool_use_id (tool events), and model is always present.
//
// REDACTION BY DEFAULT: we only ever surface tool names and argument KEY names
// (Object.keys of tool_input/arguments), never argument values, unless
// AER_HOOK_RECORD_ARGS=1.

export type HookKind =
  | 'session_start'
  | 'tool_start'
  | 'tool_end'
  | 'session_end'
  | 'prompt'
  | 'other';

export interface HookEvent {
  kind: HookKind;
  tool?: string | undefined;
  argKeys?: string[] | undefined;
  ok?: boolean | undefined;
  isError?: boolean | undefined;
  sessionRef?: string | undefined;
}

export type Harness = 'claude-code' | 'codex';

export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

export function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Whether argument values may be recorded. Off unless AER_HOOK_RECORD_ARGS=1. */
export function recordArgsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['AER_HOOK_RECORD_ARGS'] === '1';
}

/** Redaction-safe: the sorted key names of a tool-input/arguments object, never values. */
export function keysOf(v: unknown): string[] | undefined {
  const rec = asRecord(v);
  if (!rec) return undefined;
  return Object.keys(rec).sort();
}

function kindFromEventName(name: string): HookKind {
  switch (name) {
    case 'SessionStart':
    case 'SubagentStart':
      return 'session_start';
    case 'PreToolUse':
      return 'tool_start';
    case 'PostToolUse':
      return 'tool_end';
    case 'Stop':
    case 'SubagentStop':
      return 'session_end';
    case 'UserPromptSubmit':
      return 'prompt';
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

/**
 * Map a Claude Code hook payload to a HookEvent. Reads the common fields
 * defensively so an unexpected or partial payload still yields a usable event.
 */
export function normalizeClaudeCode(
  payload: unknown,
  env: NodeJS.ProcessEnv = process.env,
): HookEvent {
  const p = asRecord(payload) ?? {};
  const eventName = asString(p['hook_event_name']) ?? '';
  const kind = kindFromEventName(eventName);
  const event: HookEvent = { kind };

  const sessionRef = asString(p['session_id']);
  if (sessionRef !== undefined) event.sessionRef = sessionRef;

  if (kind === 'tool_start' || kind === 'tool_end') {
    const tool = asString(p['tool_name']);
    if (tool !== undefined) event.tool = tool;
    const argKeys = recordArgsEnabled(env)
      ? keysOfWithValues(p['tool_input'])
      : keysOf(p['tool_input']);
    if (argKeys !== undefined) event.argKeys = argKeys;
  }

  if (kind === 'tool_end') {
    const isError = responseIsError(p['tool_response']);
    if (isError !== undefined) {
      event.isError = isError;
      event.ok = !isError;
    } else if (p['tool_response'] !== undefined) {
      // A response with no error signal is treated as success.
      event.isError = false;
      event.ok = true;
    }
  }

  return event;
}

/**
 * Map an OpenAI Codex CLI hook payload to a HookEvent. Codex uses the same field
 * names as Claude Code for tool events, so this shares the mapping logic; it is a
 * distinct entry point so harness-specific fields can diverge without churn.
 */
export function normalizeCodex(payload: unknown, env: NodeJS.ProcessEnv = process.env): HookEvent {
  const p = asRecord(payload) ?? {};
  // Codex additionally may carry tool args under `arguments` for some tools; prefer
  // tool_input and fall back to arguments.
  const eventName = asString(p['hook_event_name']) ?? '';
  const kind = kindFromEventName(eventName);
  const event: HookEvent = { kind };

  const sessionRef = asString(p['session_id']);
  if (sessionRef !== undefined) event.sessionRef = sessionRef;

  if (kind === 'tool_start' || kind === 'tool_end') {
    const tool = asString(p['tool_name']);
    if (tool !== undefined) event.tool = tool;
    const argsSource = p['tool_input'] !== undefined ? p['tool_input'] : p['arguments'];
    const argKeys = recordArgsEnabled(env) ? keysOfWithValues(argsSource) : keysOf(argsSource);
    if (argKeys !== undefined) event.argKeys = argKeys;
  }

  if (kind === 'tool_end') {
    const isError = responseIsError(p['tool_response']);
    if (isError !== undefined) {
      event.isError = isError;
      event.ok = !isError;
    } else if (p['tool_response'] !== undefined) {
      event.isError = false;
      event.ok = true;
    }
  }

  return event;
}

// When AER_HOOK_RECORD_ARGS=1 the operator has opted in to values. We still return
// only the key list from `keysOf` here for argKeys; opt-in value capture is applied
// downstream in core.ts, which reads the raw payload. keysOfWithValues keeps the
// same key surface so argKeys is stable regardless of the opt-in flag.
function keysOfWithValues(v: unknown): string[] | undefined {
  return keysOf(v);
}

/**
 * Pick the harness from the payload shape. Codex tool/turn events carry `turn_id`
 * or `tool_use_id`, which Claude Code does not; a bare `hook_event_name` without
 * those is Claude Code. Callers may override with an explicit harness.
 */
export function detectHarness(payload: unknown): Harness {
  const p = asRecord(payload) ?? {};
  if (asString(p['turn_id']) !== undefined || asString(p['tool_use_id']) !== undefined) {
    return 'codex';
  }
  return 'claude-code';
}

/** Normalize with an explicit or auto-detected harness. */
export function normalize(
  payload: unknown,
  harness?: Harness,
  env: NodeJS.ProcessEnv = process.env,
): HookEvent {
  const h = harness ?? detectHarness(payload);
  return h === 'codex' ? normalizeCodex(payload, env) : normalizeClaudeCode(payload, env);
}
