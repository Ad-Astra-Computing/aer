// Turn a Codex hook event's transcript_path into llm.completed events, at the
// lifecycle points a turn's usage is actually settled: PostToolUse, turn end,
// SessionEnd. Mirrors claude-code-transcript.ts's wiring; cli.ts picks
// whichever of the two matches the event's harness, never both.
//
// Unlike Claude Code's transcript, a Codex rollout line carries no model of
// its own (see shared/codex-usage.ts): the model comes from the triggering
// hook event's own `meta.model`, which Codex sends on every event. No model
// on that event means no llm.completed is emitted for this call, since
// `model` is a required field on the wire shape, never sent as a guess.
//
// The provider, by contrast, IS in the rollout: session_meta's
// payload.model_provider, written once as the file's first line. Read once
// and cached in state.provider; providerOf(model) only covers a transcript
// that predates this field or was truncated before line one.

import type { EventSink } from '@adastracomputing/aer-emit';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import type { HookEvent } from './normalize.js';
import { tailCodexTranscript, type CodexUsageEvent } from './codex-transcript-tail.js';
import { providerOf } from './shared/model-usage.js';
import { extractCodexSessionMeta } from './shared/codex-usage.js';
import { stripToIngestPayload } from './shared/ingest-allowlist.js';

/** How many response ids to remember per harness session, to bound the store. */
const MAX_TRACKED_RESPONSE_IDS = 300;

// session_meta is always the rollout's first line and carries the real
// provider (payload.model_provider), checked against real local sessions.
// The system prompt embedded in it (base_instructions) is the largest field
// and runs ~22 KB on every local sample seen; this bound leaves over 10x
// headroom without reading the whole file.
const SESSION_META_READ_BYTES = 256 * 1024;

// A bounded read of byte 0, independent of the main tailing cursor (which
// may already be far past line one on a large file). Undefined on failure or
// a line that is not session_meta yet, so the caller retries next scan - a
// desirable race-tolerant default - or falls back to providerOf(model).
// Fail-open like every other read here; stops once the caller caches a hit.
function readSessionMetaProvider(transcriptPath: string): string | undefined {
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const size = Math.min(fs.fstatSync(fd).size, SESSION_META_READ_BYTES);
      const buf = Buffer.alloc(size);
      const bytesRead = fs.readSync(fd, buf, 0, size, 0);
      const text = buf.toString('utf8', 0, bytesRead);
      const newline = text.indexOf('\n');
      const firstLine = newline === -1 ? text : text.slice(0, newline);
      if (firstLine.trim().length === 0) return undefined;
      return extractCodexSessionMeta(JSON.parse(firstLine))?.provider;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/**
 * The first read of a transcript the hook has not seen before (the hook was
 * installed partway through a session, or the state expired) covers only its
 * tail, and keeps only the most recent model calls in it.
 */
export const FIRST_SCAN_TAIL_BYTES = 1024 * 1024;
export const FIRST_SCAN_MAX_EVENTS = 50;

const SCAN_KINDS: ReadonlySet<HookEvent['kind']> = new Set(['tool_end', 'turn_end', 'session_end']);

/** Whether this event is a point at which a Codex turn's usage is settled. */
export function shouldScanCodexTranscript(event: HookEvent): boolean {
  return event.meta?.['harness'] === 'codex' && event.transcriptPath !== undefined && SCAN_KINDS.has(event.kind);
}

/**
 * The subset of SessionState this module reads and writes. Shares the exact
 * field names claude-code-transcript.ts uses: a session runs under one
 * harness, so the two modules never contend for the same state.
 */
export interface CodexTranscriptUsageState {
  transcriptPath?: string;
  transcriptOffset?: number;
  emittedLlmMessageIds?: string[];
  /** Read once off session_meta and cached; providerOf(model) is the fallback. */
  provider?: string;
}

export interface CodexTranscriptUsageResult {
  emitted: number;
  state: CodexTranscriptUsageState;
}

function deterministicEventId(sessionRef: string, responseId: string): string {
  const h = createHash('sha256').update(`aer-hooks|llm.completed|${sessionRef}|${responseId}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function toPayload(usage: CodexUsageEvent, sessionRef: string | undefined, model: string, provider: string | undefined): Record<string, unknown> {
  const payload: Record<string, unknown> = { model, ok: true, source: 'harness_transcript' };
  const resolvedProvider = provider ?? providerOf(model);
  if (resolvedProvider !== undefined) payload['provider'] = resolvedProvider;
  if (usage.inputTokens !== undefined) payload['input_tokens'] = usage.inputTokens;
  if (usage.outputTokens !== undefined) payload['output_tokens'] = usage.outputTokens;
  if (sessionRef !== undefined) payload['session_ref'] = sessionRef;
  if (usage.turnId !== undefined) payload['turn_id'] = usage.turnId;
  return payload;
}

export interface CodexTranscriptScan {
  events: CodexUsageEvent[];
  state: CodexTranscriptUsageState;
}

// Read the event's transcript for newly-settled responses (fs only, no
// network/sink). Split out from emission the same way scanTranscriptForLlmUsage
// is, so a caller can persist the updated offset/ids before the network call
// that follows.
export function scanCodexTranscriptForLlmUsage(event: HookEvent, prior: CodexTranscriptUsageState): CodexTranscriptScan {
  if (!shouldScanCodexTranscript(event) || event.transcriptPath === undefined) {
    return { events: [], state: prior };
  }
  try {
    const transcriptPath = event.transcriptPath;
    const sameFile = prior.transcriptPath === transcriptPath;
    let offset = sameFile ? (prior.transcriptOffset ?? 0) : 0;
    const emittedResponseIds = sameFile ? (prior.emittedLlmMessageIds ?? []) : [];
    let startsMidLine = false;
    if (!sameFile) {
      const size = fs.statSync(transcriptPath).size;
      if (size > FIRST_SCAN_TAIL_BYTES) {
        offset = size - FIRST_SCAN_TAIL_BYTES;
        startsMidLine = true;
      }
    }

    const result = tailCodexTranscript({ transcriptPath, offset, emittedResponseIds, startsMidLine });
    const events = sameFile ? result.events : result.events.slice(-FIRST_SCAN_MAX_EVENTS);
    const nextIds = [...emittedResponseIds, ...events.map((e) => e.responseId)].slice(-MAX_TRACKED_RESPONSE_IDS);
    // Cached once found; a session has one provider for its whole life, so a
    // session_meta already read is never re-read.
    const provider = (sameFile ? prior.provider : undefined) ?? readSessionMetaProvider(transcriptPath);

    return {
      events,
      state: {
        transcriptPath, transcriptOffset: result.nextOffset, emittedLlmMessageIds: nextIds,
        ...(provider !== undefined ? { provider } : {}),
      },
    };
  } catch {
    return { events: [], state: prior };
  }
}

/**
 * Emit already-scanned usage events through the sink. Never throws. `model`
 * is the triggering hook event's own `meta.model`: undefined means this call
 * emits nothing, since `model` is required on the llm.completed wire shape
 * and a Codex rollout line carries none of its own to fall back to.
 */
export function emitCodexLlmUsageEvents(
  events: CodexUsageEvent[],
  sink: EventSink,
  sessionRef: string | undefined,
  model: string | undefined,
  provider?: string,
): number {
  if (model === undefined || events.length === 0) return 0;
  let emitted = 0;
  try {
    for (const usage of events) {
      const { payload } = stripToIngestPayload(toPayload(usage, sessionRef, model, provider));
      const eventId = deterministicEventId(sessionRef ?? usage.responseId, usage.responseId);
      void sink.emit('llm.completed', payload, eventId);
      emitted += 1;
    }
  } catch {
    /* fail open, like every other emit path in this package */
  }
  return emitted;
}

function modelOf(event: HookEvent): string | undefined {
  const m = event.meta?.['model'];
  return typeof m === 'string' ? m : undefined;
}

// Scan + emit in one call: a convenience wrapper for a caller with no reason
// to persist state between the two steps.
export function emitTranscriptLlmUsageForCodex(
  event: HookEvent,
  sink: EventSink,
  prior: CodexTranscriptUsageState,
  sessionRef: string | undefined,
): CodexTranscriptUsageResult {
  const scan = scanCodexTranscriptForLlmUsage(event, prior);
  const emitted = emitCodexLlmUsageEvents(scan.events, sink, sessionRef, modelOf(event), scan.state.provider);
  return { emitted, state: scan.state };
}
