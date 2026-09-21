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
 *   tool_start -> tool.started   { tool, arg_keys, tool_use_id }
 *   tool_end   -> tool.completed { tool, ok, is_error, tool_use_id }
 *   every other kind -> collector.report { collector, phase }
 *
 * The harness lifecycle markers are recorded as collector.report phases (a
 * valid EventSchema type) rather than as session.started/ended: the AER
 * session lifecycle is owned by the sink's open + complete, so synthetic
 * lifecycle events would be redundant and could skew the generator's
 * observations. hook_start/hook_end/prompt.submitted are not EventSchema types
 * and the API rejects them per-event.
 *
 * Every payload carries the harness metadata the event came with, so a reader
 * can tell which harness, model and permission mode produced the run without
 * inferring it. Any failure inside the sink is swallowed; this never throws.
 */
export function emitHookEvent(event: HookEvent, sink: EventSink, _opts: EmitOptions = {}): void {
  try {
    if (event.kind === 'other') return;

    const payload: Record<string, unknown> = { ...(event.meta ?? {}) };
    if (event.sessionRef !== undefined) payload['session_ref'] = event.sessionRef;
    if (event.seq !== undefined) payload['seq'] = event.seq;

    switch (event.kind) {
      case 'tool_start': {
        if (event.tool !== undefined) payload['tool'] = event.tool;
        if (event.argKeys !== undefined) payload['arg_keys'] = event.argKeys;
        emitFiltered(sink, 'tool.started', payload);
        return;
      }
      case 'tool_end': {
        if (event.tool !== undefined) payload['tool'] = event.tool;
        if (event.ok !== undefined) payload['ok'] = event.ok;
        if (event.isError !== undefined) payload['is_error'] = event.isError;
        emitFiltered(sink, 'tool.completed', payload);
        return;
      }
      default: {
        // collector.report requires a non-empty `collector`; `phase` rides
        // along via the variant's passthrough() to carry which marker this is.
        payload['collector'] = 'aer-hooks';
        payload['phase'] = event.kind;
        emitFiltered(sink, 'collector.report', payload);
        return;
      }
    }
  } catch {
    /* emit must never throw */
  }
}
