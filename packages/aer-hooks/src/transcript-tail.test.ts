// tailTranscript reads whatever complete new JSONL lines a Claude Code
// transcript has gained since the last call, bounded and fail-open, and
// reduces each assistant entry to model + token counts. This locks the
// incremental-read contract in isolation, before session-store/cli wiring.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { tailTranscript, MAX_TRANSCRIPT_READ_BYTES } from './transcript-tail.js';

function assistantLine(opts: { id: string; uuid: string; model?: string; inTok?: number; outTok?: number; ts?: string; text?: string }): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: opts.uuid,
    timestamp: opts.ts ?? '2026-09-01T00:00:00.000Z',
    message: {
      id: opts.id,
      role: 'assistant',
      model: opts.model ?? 'claude-opus-4-8',
      usage: { input_tokens: opts.inTok ?? 10, output_tokens: opts.outTok ?? 20, cache_read_input_tokens: 9999 },
      content: [{ type: 'text', text: opts.text ?? 'SECRET-COMPLETION-TEXT' }],
    },
  });
}

function userToolResultLine(): string {
  return JSON.stringify({
    type: 'user',
    uuid: 'u1',
    timestamp: '2026-09-01T00:00:01.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'SECRET-RESULT-TEXT' }] },
  });
}

describe('tailTranscript', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aer-transcript-'));
    file = path.join(dir, 't.jsonl');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads new complete assistant lines and extracts model + token counts only', () => {
    fs.writeFileSync(file, assistantLine({ id: 'msg_1', uuid: 'a1', inTok: 12, outTok: 340 }) + '\n');
    const result = tailTranscript({ transcriptPath: file, offset: 0, emittedMessageIds: [] });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ messageId: 'msg_1', model: 'claude-opus-4-8', provider: 'anthropic', inputTokens: 12, outputTokens: 340 });
    expect(result.nextOffset).toBeGreaterThan(0);
    expect(result.reset).toBe(false);
  });

  it('never carries message text or tool result content in the result', () => {
    fs.writeFileSync(file, assistantLine({ id: 'msg_1', uuid: 'a1' }) + '\n' + userToolResultLine() + '\n');
    const result = tailTranscript({ transcriptPath: file, offset: 0, emittedMessageIds: [] });
    const blob = JSON.stringify(result);
    expect(blob).not.toContain('SECRET-COMPLETION-TEXT');
    expect(blob).not.toContain('SECRET-RESULT-TEXT');
  });

  it('does not consume a trailing partial line', () => {
    const complete = assistantLine({ id: 'msg_1', uuid: 'a1' }) + '\n';
    const partial = '{"type":"assistant","message":{"id":"msg_2"';
    fs.writeFileSync(file, complete + partial);
    const result = tailTranscript({ transcriptPath: file, offset: 0, emittedMessageIds: [] });
    expect(result.events.map((e) => e.messageId)).toEqual(['msg_1']);
    expect(result.nextOffset).toBe(Buffer.byteLength(complete, 'utf8'));
  });

  it('is incremental: a second call from the returned offset sees only newly appended lines', () => {
    fs.writeFileSync(file, assistantLine({ id: 'msg_1', uuid: 'a1' }) + '\n');
    const first = tailTranscript({ transcriptPath: file, offset: 0, emittedMessageIds: [] });
    fs.appendFileSync(file, assistantLine({ id: 'msg_2', uuid: 'a2' }) + '\n');
    const second = tailTranscript({ transcriptPath: file, offset: first.nextOffset, emittedMessageIds: [] });
    expect(second.events.map((e) => e.messageId)).toEqual(['msg_2']);
  });

  it('dedupes streamed partial entries sharing a message id, keeping the final usage', () => {
    const stream =
      assistantLine({ id: 'msg_1', uuid: 'a1', inTok: 5, outTok: 1 }) + '\n' +
      assistantLine({ id: 'msg_1', uuid: 'a2', inTok: 5, outTok: 40 }) + '\n' +
      assistantLine({ id: 'msg_1', uuid: 'a3', inTok: 5, outTok: 340 }) + '\n';
    fs.writeFileSync(file, stream);
    const result = tailTranscript({ transcriptPath: file, offset: 0, emittedMessageIds: [] });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.outputTokens).toBe(340);
  });

  it('skips a message id already in emittedMessageIds', () => {
    fs.writeFileSync(file, assistantLine({ id: 'msg_1', uuid: 'a1' }) + '\n');
    const result = tailTranscript({ transcriptPath: file, offset: 0, emittedMessageIds: ['msg_1'] });
    expect(result.events).toHaveLength(0);
  });

  it('resets to offset 0 without re-emitting when the file shrinks (truncation/rotation)', () => {
    fs.writeFileSync(file, assistantLine({ id: 'msg_1', uuid: 'a1' }) + '\n' + assistantLine({ id: 'msg_2', uuid: 'a2' }) + '\n');
    const first = tailTranscript({ transcriptPath: file, offset: 0, emittedMessageIds: [] });
    expect(first.events.map((e) => e.messageId)).toEqual(['msg_1', 'msg_2']);

    // Truncate to a short new transcript (a new session reusing the path).
    fs.writeFileSync(file, assistantLine({ id: 'msg_3', uuid: 'a3' }) + '\n');
    const afterTruncate = tailTranscript({
      transcriptPath: file,
      offset: first.nextOffset,
      emittedMessageIds: ['msg_1', 'msg_2'],
    });
    expect(afterTruncate.reset).toBe(true);
    // Only the genuinely new message comes back; the already-emitted ids
    // from before the truncation are never repeated even though the offset
    // reset re-scans from byte 0.
    expect(afterTruncate.events.map((e) => e.messageId)).toEqual(['msg_3']);
  });

  it('bounds the read to MAX_TRANSCRIPT_READ_BYTES and carries the offset forward', () => {
    const line = assistantLine({ id: 'msg_pad', uuid: 'pad', text: 'x'.repeat(1000) }) + '\n';
    const linesNeeded = Math.ceil((MAX_TRANSCRIPT_READ_BYTES * 1.5) / Buffer.byteLength(line, 'utf8'));
    let content = '';
    for (let i = 0; i < linesNeeded; i++) {
      content += assistantLine({ id: `msg_${i}`, uuid: `u${i}`, text: 'x'.repeat(1000) }) + '\n';
    }
    fs.writeFileSync(file, content);
    const first = tailTranscript({ transcriptPath: file, offset: 0, emittedMessageIds: [] });
    expect(first.nextOffset).toBeLessThan(Buffer.byteLength(content, 'utf8'));
    expect(first.nextOffset).toBeLessThanOrEqual(MAX_TRANSCRIPT_READ_BYTES);

    const second = tailTranscript({ transcriptPath: file, offset: first.nextOffset, emittedMessageIds: first.events.map((e) => e.messageId) });
    // Together the two bounded reads eventually see every line.
    const seen = new Set([...first.events, ...second.events].map((e) => e.messageId));
    expect(seen.has('msg_0')).toBe(true);
  });

  it('tolerates a missing transcript file silently', () => {
    const result = tailTranscript({ transcriptPath: path.join(dir, 'nope.jsonl'), offset: 0, emittedMessageIds: [] });
    expect(result.events).toEqual([]);
    expect(result.nextOffset).toBe(0);
    expect(result.reset).toBe(false);
  });

  it('tolerates malformed JSON lines and non-assistant entries', () => {
    fs.writeFileSync(
      file,
      'not json at all\n' +
        JSON.stringify({ type: 'system', uuid: 's1' }) + '\n' +
        assistantLine({ id: 'msg_1', uuid: 'a1' }) + '\n',
    );
    const result = tailTranscript({ transcriptPath: file, offset: 0, emittedMessageIds: [] });
    expect(result.events.map((e) => e.messageId)).toEqual(['msg_1']);
  });

  it('falls back to entry.uuid when the message carries no id', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'assistant',
        uuid: 'fallback-uuid',
        timestamp: '2026-09-01T00:00:00.000Z',
        message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 1, output_tokens: 2 } },
      }) + '\n',
    );
    const result = tailTranscript({ transcriptPath: file, offset: 0, emittedMessageIds: [] });
    expect(result.events[0]!.messageId).toBe('fallback-uuid');
  });

  it('skips an assistant entry with no model rather than emitting a partial marker', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', usage: { input_tokens: 1 } } }) + '\n',
    );
    const result = tailTranscript({ transcriptPath: file, offset: 0, emittedMessageIds: [] });
    expect(result.events).toEqual([]);
  });

  it('carries agentType/isSidechain for a subagent transcript entry', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        isSidechain: true,
        agentType: 'code-reviewer',
        timestamp: '2026-09-01T00:00:00.000Z',
        message: { id: 'msg_sub', role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 1, output_tokens: 2 } },
      }) + '\n',
    );
    const result = tailTranscript({ transcriptPath: file, offset: 0, emittedMessageIds: [] });
    expect(result.events[0]).toMatchObject({ isSidechain: true, agentType: 'code-reviewer' });
  });
});
