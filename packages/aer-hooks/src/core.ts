// Map a normalized HookEvent to AER event types and emit it. Never throws.
//
// Redaction by default: the emitted payload carries the tool name, argument KEY
// names and result flags only, never argument values or result content, unless the
// operator opts in with AER_HOOK_RECORD_ARGS=1 (in which case the raw tool_input is
// forwarded under `arg_values`, if a raw payload is supplied).

import type { EventSink } from '@adastracomputing/aer-emit';
import type { HookEvent } from './normalize.js';
import { recordArgsEnabled } from './normalize.js';

export interface EmitOptions {
  /** The raw hook payload; only read when AER_HOOK_RECORD_ARGS=1 to attach values. */
  raw?: unknown;
  env?: NodeJS.ProcessEnv;
}

function rawToolInput(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const ti = rec['tool_input'] ?? rec['arguments'];
  if (typeof ti === 'object' && ti !== null && !Array.isArray(ti)) {
    return ti as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Emit one normalized hook event through the sink. Maps:
 *   tool_start    -> tool.started    { tool, arg_keys }
 *   tool_end      -> tool.completed  { tool, ok, is_error }
 *   session_start -> collector.report { collector, phase: 'session_start' }
 *   session_end   -> collector.report { collector, phase: 'session_end' }
 *   prompt        -> collector.report { collector, phase: 'prompt' }
 *   other         -> (dropped)
 *
 * The harness session boundaries and prompt turns are recorded as
 * collector.report markers (a valid EventSchema type) rather than as
 * session.started/ended: the AER session lifecycle is owned by the sink's
 * open + complete, so synthetic lifecycle events would be redundant and could
 * skew the generator's observations. hook_start/hook_end/prompt.submitted are
 * not EventSchema types and the API rejects them per-event.
 * Any failure inside the sink is swallowed; this function never throws.
 */
export function emitHookEvent(event: HookEvent, sink: EventSink, opts: EmitOptions = {}): void {
  try {
    const env = opts.env ?? process.env;
    switch (event.kind) {
      case 'tool_start': {
        const payload: Record<string, unknown> = {};
        if (event.tool !== undefined) payload['tool'] = event.tool;
        if (event.argKeys !== undefined) payload['arg_keys'] = event.argKeys;
        if (event.sessionRef !== undefined) payload['session_ref'] = event.sessionRef;
        if (recordArgsEnabled(env)) {
          const values = rawToolInput(opts.raw);
          if (values !== undefined) payload['arg_values'] = values;
        }
        void sink.emit('tool.started', payload);
        return;
      }
      case 'tool_end': {
        const payload: Record<string, unknown> = {};
        if (event.tool !== undefined) payload['tool'] = event.tool;
        if (event.ok !== undefined) payload['ok'] = event.ok;
        if (event.isError !== undefined) payload['is_error'] = event.isError;
        if (event.sessionRef !== undefined) payload['session_ref'] = event.sessionRef;
        void sink.emit('tool.completed', payload);
        return;
      }
      case 'session_start':
      case 'session_end':
      case 'prompt': {
        // collector.report requires a non-empty `collector`; `phase` rides along
        // via the variant's passthrough() to carry which marker this is.
        const phase =
          event.kind === 'session_start' ? 'session_start' : event.kind === 'session_end' ? 'session_end' : 'prompt';
        const payload: Record<string, unknown> = { collector: 'aer-hooks', phase };
        if (event.sessionRef !== undefined) payload['session_ref'] = event.sessionRef;
        void sink.emit('collector.report', payload);
        return;
      }
      case 'other':
      default:
        return;
    }
  } catch {
    /* emit must never throw */
  }
}
