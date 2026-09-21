// Map a normalized HookEvent to AER event types and emit it. Never throws.
//
// Redaction always: the emitted payload carries the tool name, argument KEY
// names and result flags only, never argument values or result content. Every
// payload is filtered through the ingest allowlist before it is handed to the
// sink, so a key ingest would discard never reaches the wire in the first
// place.

import type { EventSink } from '@adastracomputing/aer-emit';
import type { HookEvent } from './normalize.js';
import { stripToIngestPayload } from './shared/ingest-allowlist.js';

export interface EmitOptions {
  env?: NodeJS.ProcessEnv;
}

/**
 * Hand one payload to the sink, minus anything ingest would drop. Filtering
 * here rather than trusting the server keeps the privacy claim true on the
 * wire and not just in the database.
 */
function emitFiltered(sink: EventSink, type: string, payload: Record<string, unknown>): void {
  const { payload: safe } = stripToIngestPayload(payload);
  void sink.emit(type, safe);
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
export function emitHookEvent(event: HookEvent, sink: EventSink, _opts: EmitOptions = {}): void {
  try {
    switch (event.kind) {
      case 'tool_start': {
        const payload: Record<string, unknown> = {};
        if (event.tool !== undefined) payload['tool'] = event.tool;
        if (event.argKeys !== undefined) payload['arg_keys'] = event.argKeys;
        if (event.sessionRef !== undefined) payload['session_ref'] = event.sessionRef;
        emitFiltered(sink, 'tool.started', payload);
        return;
      }
      case 'tool_end': {
        const payload: Record<string, unknown> = {};
        if (event.tool !== undefined) payload['tool'] = event.tool;
        if (event.ok !== undefined) payload['ok'] = event.ok;
        if (event.isError !== undefined) payload['is_error'] = event.isError;
        if (event.sessionRef !== undefined) payload['session_ref'] = event.sessionRef;
        emitFiltered(sink, 'tool.completed', payload);
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
        emitFiltered(sink, 'collector.report', payload);
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
