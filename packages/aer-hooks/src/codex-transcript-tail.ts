// Incrementally read a Codex CLI rollout transcript and reduce newly-appended
// token_usage_record lines to per-response token counts. Mirrors
// transcript-tail.ts's windowing, minus its streaming-duplicate handling: a
// token_usage_record is appended once per response and never rewritten
// (shared/codex-usage.ts), so there is no "still growing" line. Bodies-off
// (extractCodexUsage only), fail-open, bounded per call by
// MAX_TRANSCRIPT_READ_BYTES, offset carried forward by the caller.

import * as fs from 'node:fs';
import { extractCodexUsage } from './shared/codex-usage.js';

/** Per-invocation read cap. A large rollout is read across several hooks. */
export const MAX_TRANSCRIPT_READ_BYTES = 4 * 1024 * 1024;

export interface CodexUsageEvent {
  responseId: string;
  turnId?: string;
  inputTokens?: number;
  outputTokens?: number;
  timestamp?: string;
}

export interface CodexTranscriptTailState {
  transcriptPath: string;
  /** Byte offset already consumed. */
  offset: number;
  /** Response ids already turned into an event in a prior call. */
  emittedResponseIds: string[];
  /**
   * The offset may fall inside a line (a read that starts partway into the
   * file), so the first line of the window is discarded rather than parsed.
   */
  startsMidLine?: boolean;
}

export interface CodexTranscriptTailResult {
  /** New, not-yet-emitted usage events, oldest first. */
  events: CodexUsageEvent[];
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
// token_usage_record line to a usage event. A file smaller than the offset is
// presumed truncated/rotated and restarts from byte 0; emittedResponseIds
// still blocks a repeat of anything already recorded. Never throws.
export function tailCodexTranscript(state: CodexTranscriptTailState): CodexTranscriptTailResult {
  try {
    const stat = fs.statSync(state.transcriptPath);
    // A FIFO, device or directory at this path is never a transcript.
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

    const alreadyEmitted = new Set(state.emittedResponseIds);
    const events: CodexUsageEvent[] = [];

    let first = true;
    for (const line of consumed.split('\n')) {
      const partial = first && state.startsMidLine === true && !reset;
      first = false;
      if (partial) continue;

      if (line.trim().length === 0) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const usage = extractCodexUsage(entry);
      if (!usage) continue;
      if (alreadyEmitted.has(usage.responseId)) continue;
      alreadyEmitted.add(usage.responseId);

      const event: CodexUsageEvent = { responseId: usage.responseId };
      if (usage.turnId !== undefined) event.turnId = usage.turnId;
      if (usage.inputTokens !== undefined) event.inputTokens = usage.inputTokens;
      if (usage.outputTokens !== undefined) event.outputTokens = usage.outputTokens;
      const timestamp = isObj(entry) ? asString(entry['timestamp']) : undefined;
      if (timestamp !== undefined) event.timestamp = timestamp;
      events.push(event);
    }

    return { events, nextOffset, reset };
  } catch {
    return { events: [], nextOffset: state.offset, reset: false };
  }
}
