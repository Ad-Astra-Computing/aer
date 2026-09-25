// Turn a hook event's transcript_path into llm.completed events, at the
// lifecycle points a turn's usage is actually settled: PostToolUse, Stop,
// SubagentStop, SessionEnd. Fail-open like the rest of this package.

import type { EventSink } from '@adastracomputing/aer-emit';
import { createHash } from 'node:crypto';
import type { HookEvent } from './normalize.js';
import { tailTranscript, type LlmUsageEvent } from './transcript-tail.js';
import { stripToIngestPayload } from './shared/ingest-allowlist.js';

/** How many message ids to remember per harness session, to bound the store. */
const MAX_TRACKED_MESSAGE_IDS = 300;

const SCAN_KINDS: ReadonlySet<HookEvent['kind']> = new Set(['tool_end', 'turn_end', 'session_end', 'subagent_end']);

/** Whether this event is a point at which a Claude Code turn's usage is settled. */
export function shouldScanTranscript(event: HookEvent): boolean {
  return event.meta?.['harness'] === 'claude-code' && event.transcriptPath !== undefined && SCAN_KINDS.has(event.kind);
}

/** The subset of StoredSession this module reads and writes. */
export interface TranscriptUsageState {
  transcriptPath?: string;
  transcriptOffset?: number;
  emittedLlmMessageIds?: string[];
}

export interface TranscriptUsageResult {
  emitted: number;
  state: TranscriptUsageState;
}

/**
 * A stable event_id derived from the harness session + message id, so
 * re-scanning the same transcript window (e.g. after a lock-contention
 * degrade to single-shot) is idempotent at ingest rather than producing a
 * second row for the same model call.
 */
function deterministicEventId(sessionRef: string, messageId: string): string {
  const h = createHash('sha256').update(`aer-hooks|llm.completed|${sessionRef}|${messageId}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function toPayload(usage: LlmUsageEvent, sessionRef: string | undefined): Record<string, unknown> {
  const payload: Record<string, unknown> = { model: usage.model, ok: true, source: 'harness_transcript' };
  if (usage.provider !== undefined) payload['provider'] = usage.provider;
  if (usage.inputTokens !== undefined) payload['input_tokens'] = usage.inputTokens;
  if (usage.outputTokens !== undefined) payload['output_tokens'] = usage.outputTokens;
  if (sessionRef !== undefined) payload['session_ref'] = sessionRef;
  if (usage.agentType !== undefined) payload['agent_type'] = usage.agentType;
  return payload;
}

export interface TranscriptScan {
  events: LlmUsageEvent[];
  state: TranscriptUsageState;
}

// Read the event's transcript for newly-settled assistant turns (fs only, no
// network/sink). Split out from emission so a caller can persist the updated
// offset/ids before the network call that follows, as cli.ts's session-attach
// path already does for `seq`. A `prior.transcriptPath` that differs from the
// event's means a fresh transcript, so its offset/ids are not reused.
export function scanTranscriptForLlmUsage(event: HookEvent, prior: TranscriptUsageState): TranscriptScan {
  if (!shouldScanTranscript(event) || event.transcriptPath === undefined) {
    return { events: [], state: prior };
  }
  try {
    const transcriptPath = event.transcriptPath;
    const sameFile = prior.transcriptPath === transcriptPath;
    const offset = sameFile ? (prior.transcriptOffset ?? 0) : 0;
    const emittedMessageIds = sameFile ? (prior.emittedLlmMessageIds ?? []) : [];

    const result = tailTranscript({ transcriptPath, offset, emittedMessageIds });
    const nextIds = [...emittedMessageIds, ...result.events.map((e) => e.messageId)].slice(-MAX_TRACKED_MESSAGE_IDS);

    return {
      events: result.events,
      state: { transcriptPath, transcriptOffset: result.nextOffset, emittedLlmMessageIds: nextIds },
    };
  } catch {
    return { events: [], state: prior };
  }
}

/** Emit already-scanned usage events through the sink. Never throws. */
export function emitLlmUsageEvents(events: LlmUsageEvent[], sink: EventSink, sessionRef: string | undefined): number {
  let emitted = 0;
  try {
    for (const usage of events) {
      const { payload } = stripToIngestPayload(toPayload(usage, sessionRef));
      const eventId = deterministicEventId(sessionRef ?? usage.messageId, usage.messageId);
      void sink.emit('llm.completed', payload, eventId);
      emitted += 1;
    }
  } catch {
    /* fail open, like every other emit path in this package */
  }
  return emitted;
}

// Scan + emit in one call: a convenience wrapper for a caller with no reason
// to persist state between the two steps.
export function emitTranscriptLlmUsage(
  event: HookEvent,
  sink: EventSink,
  prior: TranscriptUsageState,
  sessionRef: string | undefined,
): TranscriptUsageResult {
  const scan = scanTranscriptForLlmUsage(event, prior);
  const emitted = emitLlmUsageEvents(scan.events, sink, sessionRef);
  return { emitted, state: scan.state };
}
