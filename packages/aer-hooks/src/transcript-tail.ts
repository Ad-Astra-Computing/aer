// Incrementally read a Claude Code transcript and reduce newly-appended
// assistant entries to model + token counts (see normalize.ts for why: no
// hook payload carries either). Bodies-off (extractClaudeCodeUsage only),
// fail-open, bounded per call by MAX_TRANSCRIPT_READ_BYTES, with the offset
// carried forward by the caller.

import * as fs from 'node:fs';
import { extractClaudeCodeUsage, identifierField } from './shared/claude-code-usage.js';

/** Per-invocation read cap. A large transcript is read across several hooks. */
export const MAX_TRANSCRIPT_READ_BYTES = 4 * 1024 * 1024;

export interface LlmUsageEvent {
  messageId: string;
  model: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  timestamp?: string;
  agentType?: string;
  isSidechain?: boolean;
}

export interface TranscriptTailState {
  transcriptPath: string;
  /** Byte offset already consumed. */
  offset: number;
  /** Assistant message ids already turned into an event in a prior call. */
  emittedMessageIds: string[];
}

export interface TranscriptTailResult {
  /** New, not-yet-emitted usage events, oldest first. */
  events: LlmUsageEvent[];
  /** The offset the next call should read from. */
  nextOffset: number;
  /** Whether the file was smaller than the offset (truncated or rotated). */
  reset: boolean;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// Reads new complete lines past state.offset (bounded), reducing each
// assistant entry to a usage event. A file smaller than the offset is
// presumed truncated/rotated and restarts from byte 0; emittedMessageIds
// still blocks a repeat of anything already recorded. Never throws.
export function tailTranscript(state: TranscriptTailState): TranscriptTailResult {
  try {
    const stat = fs.statSync(state.transcriptPath);
    // A FIFO, device or directory at this path is never a transcript. Most
    // report size 0 and would be silently skipped below anyway, but a
    // blocking device (e.g. a FIFO with a writer) could hang the read, so
    // this is refused up front rather than relying on that coincidence.
    if (!stat.isFile()) {
      return { events: [], nextOffset: state.offset, reset: false };
    }
    let offset = state.offset;
    let reset = false;
    if (stat.size < offset) {
      offset = 0;
      reset = true;
    }
    if (stat.size <= offset) {
      return { events: [], nextOffset: offset, reset };
    }

    const readLength = Math.min(stat.size - offset, MAX_TRANSCRIPT_READ_BYTES);
    const buf = Buffer.alloc(readLength);
    const fd = fs.openSync(state.transcriptPath, 'r');
    try {
      fs.readSync(fd, buf, 0, readLength, offset);
    } finally {
      fs.closeSync(fd);
    }

    const text = buf.toString('utf8');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) {
      // No complete line in this window yet; nothing consumed.
      return { events: [], nextOffset: offset, reset };
    }

    // '\n' is a single ASCII byte and cannot occur inside a UTF-8 multi-byte
    // sequence, so cutting here is always a valid byte boundary even if the
    // tail of `buf` (past this point, discarded below) landed mid-character.
    const consumed = text.slice(0, lastNewline);
    const nextOffset = offset + Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8');
    // True when there is more file beyond this window: a still-streaming
    // message whose last line we happened to catch here might grow further
    // usage in bytes we have not read yet.
    const capLimited = stat.size > offset + readLength;

    const alreadyEmitted = new Set(state.emittedMessageIds);
    // Last occurrence wins, so a streamed message that appears more than
    // once in this window is reported once, with its final usage.
    const byMessageId = new Map<string, LlmUsageEvent>();
    const firstLineOffsetByMessageId = new Map<string, number>();
    let lastEntryMessageId: string | undefined;
    let runningOffset = offset;

    for (const line of consumed.split('\n')) {
      const lineStartOffset = runningOffset;
      runningOffset += Buffer.byteLength(line, 'utf8') + 1; // +1 for the '\n' this line was split on

      if (line.trim().length === 0) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isObj(entry) || entry['type'] !== 'assistant') continue;
      const message = entry['message'];
      const usage = extractClaudeCodeUsage(message);
      if (!usage) continue;
      const msg = isObj(message) ? message : undefined;
      const messageId = asString(msg?.['id']) ?? asString(entry['uuid']);
      if (!messageId) continue;
      if (alreadyEmitted.has(messageId)) continue;

      if (!firstLineOffsetByMessageId.has(messageId)) firstLineOffsetByMessageId.set(messageId, lineStartOffset);
      lastEntryMessageId = messageId;

      const event: LlmUsageEvent = { messageId, model: usage.model };
      if (usage.provider !== undefined) event.provider = usage.provider;
      if (usage.inputTokens !== undefined) event.inputTokens = usage.inputTokens;
      if (usage.outputTokens !== undefined) event.outputTokens = usage.outputTokens;
      const timestamp = asString(entry['timestamp']);
      if (timestamp !== undefined) event.timestamp = timestamp;
      const agentType = identifierField(entry['agentType']);
      if (agentType !== undefined) event.agentType = agentType;
      if (entry['isSidechain'] === true) event.isSidechain = true;
      byMessageId.set(messageId, event);
    }

    // The window may have been cut off mid-stream for whichever message id
    // the LAST line in it belongs to: more lines for that same id, carrying
    // its real final usage, could sit just past this read. Hold it back
    // (never mark it emitted) and roll the offset back to its first line
    // here, so the next call re-reads it together with whatever follows.
    if (capLimited && lastEntryMessageId !== undefined) {
      byMessageId.delete(lastEntryMessageId);
      return {
        events: [...byMessageId.values()],
        nextOffset: firstLineOffsetByMessageId.get(lastEntryMessageId)!,
        reset,
      };
    }

    return { events: [...byMessageId.values()], nextOffset, reset };
  } catch {
    return { events: [], nextOffset: state.offset, reset: false };
  }
}
