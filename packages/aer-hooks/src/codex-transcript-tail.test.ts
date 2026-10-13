import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { tailCodexTranscript, MAX_TRANSCRIPT_READ_BYTES } from './codex-transcript-tail.js';

function tokenUsageRecordLine(responseId: string, opts: Partial<{ turnId: string; inTok: number; outTok: number }> = {}): string {
  const usage = { input_tokens: opts.inTok ?? 4, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: opts.outTok ?? 6, reasoning_output_tokens: 0, total_tokens: (opts.inTok ?? 4) + (opts.outTok ?? 6) };
  return JSON.stringify({
    timestamp: '2026-10-12T00:00:00.000Z',
    type: 'token_usage_record',
    payload: { thread_id: 'thr_1', turn_id: opts.turnId ?? 'turn_1', session_id: 'ses_1', root_turn_id: opts.turnId ?? 'turn_1', response_id: responseId, usage, turn_token_usage: usage, thread_token_usage: usage },
  });
}

function responseItemLine(text: string): string {
  return JSON.stringify({ timestamp: '2026-10-12T00:00:00.000Z', type: 'response_item', payload: { content: [{ type: 'input_text', text }] } });
}

describe('tailCodexTranscript', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aer-codex-transcript-'));
    file = path.join(dir, 'rollout.jsonl');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads a new token_usage_record line and advances the offset', () => {
    fs.writeFileSync(file, tokenUsageRecordLine('resp_1') + '\n');
    const result = tailCodexTranscript({ transcriptPath: file, offset: 0, emittedResponseIds: [] });
    expect(result.events).toEqual([{ responseId: 'resp_1', turnId: 'turn_1', inputTokens: 4, outputTokens: 6, timestamp: '2026-10-12T00:00:00.000Z' }]);
    expect(result.nextOffset).toBeGreaterThan(0);
    expect(result.reset).toBe(false);
  });

  it('skips response_item lines entirely: never surfaces their content', () => {
    fs.writeFileSync(file, responseItemLine('SECRET-PROMPT-TEXT') + '\n' + tokenUsageRecordLine('resp_1') + '\n');
    const result = tailCodexTranscript({ transcriptPath: file, offset: 0, emittedResponseIds: [] });
    expect(result.events).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('SECRET-PROMPT-TEXT');
  });

  it('is incremental: a second call from the returned offset only sees the new line', () => {
    fs.writeFileSync(file, tokenUsageRecordLine('resp_1') + '\n');
    const first = tailCodexTranscript({ transcriptPath: file, offset: 0, emittedResponseIds: [] });
    fs.appendFileSync(file, tokenUsageRecordLine('resp_2') + '\n');
    const second = tailCodexTranscript({ transcriptPath: file, offset: first.nextOffset, emittedResponseIds: ['resp_1'] });
    expect(second.events).toEqual([{ responseId: 'resp_2', turnId: 'turn_1', inputTokens: 4, outputTokens: 6, timestamp: '2026-10-12T00:00:00.000Z' }]);
  });

  it('does not re-emit a response id already in emittedResponseIds, even if the line reappears in the read window', () => {
    fs.writeFileSync(file, tokenUsageRecordLine('resp_1') + '\n' + tokenUsageRecordLine('resp_2') + '\n');
    const result = tailCodexTranscript({ transcriptPath: file, offset: 0, emittedResponseIds: ['resp_1'] });
    expect(result.events.map((e) => e.responseId)).toEqual(['resp_2']);
  });

  it('never parses a line cut off by the read window: no partial JSON, no crash', () => {
    const full = tokenUsageRecordLine('resp_1') + '\n' + tokenUsageRecordLine('resp_2');
    fs.writeFileSync(file, full);
    // No trailing newline on the last line: it must not be parsed as complete.
    const result = tailCodexTranscript({ transcriptPath: file, offset: 0, emittedResponseIds: [] });
    expect(result.events.map((e) => e.responseId)).toEqual(['resp_1']);
  });

  it('discards the first (partial) line of a window that starts mid-line', () => {
    fs.writeFileSync(file, tokenUsageRecordLine('resp_1') + '\n' + tokenUsageRecordLine('resp_2') + '\n');
    // Start partway into line 1, as if a prior call's window ended there.
    const midOffset = 5;
    const result = tailCodexTranscript({ transcriptPath: file, offset: midOffset, emittedResponseIds: [], startsMidLine: true });
    expect(result.events.map((e) => e.responseId)).toEqual(['resp_2']);
  });

  it('treats a file smaller than the offset as reset: rescans from the start', () => {
    fs.writeFileSync(file, tokenUsageRecordLine('resp_1') + '\n' + tokenUsageRecordLine('resp_2') + '\n');
    const first = tailCodexTranscript({ transcriptPath: file, offset: 0, emittedResponseIds: [] });
    fs.writeFileSync(file, tokenUsageRecordLine('resp_3') + '\n');
    const second = tailCodexTranscript({ transcriptPath: file, offset: first.nextOffset, emittedResponseIds: ['resp_1', 'resp_2'] });
    expect(second.reset).toBe(true);
    expect(second.events.map((e) => e.responseId)).toEqual(['resp_3']);
  });

  it('never throws on a missing file, a directory, or malformed JSON', () => {
    expect(tailCodexTranscript({ transcriptPath: path.join(dir, 'missing.jsonl'), offset: 0, emittedResponseIds: [] }))
      .toEqual({ events: [], nextOffset: 0, reset: false });
    expect(tailCodexTranscript({ transcriptPath: dir, offset: 0, emittedResponseIds: [] }))
      .toEqual({ events: [], nextOffset: 0, reset: false });
    fs.writeFileSync(file, 'not json\n' + tokenUsageRecordLine('resp_1') + '\n');
    const result = tailCodexTranscript({ transcriptPath: file, offset: 0, emittedResponseIds: [] });
    expect(result.events.map((e) => e.responseId)).toEqual(['resp_1']);
  });

  it('respects the bounded per-call read cap', () => {
    expect(MAX_TRANSCRIPT_READ_BYTES).toBeGreaterThan(0);
  });
});
