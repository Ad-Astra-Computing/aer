// emitTranscriptLlmUsage wires tailTranscript's output into the sink, filtered
// through the same ingest allowlist as every other hook event. This is the
// piece cli.ts calls once per hook invocation.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EventSink } from '@adastracomputing/aer-emit';
import type { HookEvent } from './normalize.js';
import { shouldScanTranscript, emitTranscriptLlmUsage } from './claude-code-transcript.js';
import { INGEST_PAYLOAD_KEYS } from './shared/ingest-allowlist.js';

function assistantLine(id: string, uuid: string, opts: Partial<{ inTok: number; outTok: number; text: string }> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-09-01T00:00:00.000Z',
    message: {
      id,
      role: 'assistant',
      model: 'claude-opus-4-8',
      usage: { input_tokens: opts.inTok ?? 5, output_tokens: opts.outTok ?? 9 },
      content: [{ type: 'text', text: opts.text ?? 'SECRET-COMPLETION-TEXT' }],
    },
  });
}

function collectingSink(): { sink: EventSink; seen: Array<{ type: string; payload: Record<string, unknown>; id?: string }> } {
  const seen: Array<{ type: string; payload: Record<string, unknown>; id?: string }> = [];
  return {
    seen,
    sink: {
      emit(type: string, payload: Record<string, unknown>, id?: string) { seen.push({ type, payload, id }); },
      async close() {},
    } as unknown as EventSink,
  };
}

function toolEndEvent(transcriptPath: string): HookEvent {
  return { kind: 'tool_end', tool: 'Bash', ok: true, sessionRef: 'hs-1', transcriptPath, meta: { harness: 'claude-code' } };
}

describe('shouldScanTranscript', () => {
  it('is true for claude-code tool_end/turn_end/session_end/subagent_end with a transcript path', () => {
    for (const kind of ['tool_end', 'turn_end', 'session_end', 'subagent_end'] as const) {
      const event: HookEvent = { kind, transcriptPath: '/t.jsonl', meta: { harness: 'claude-code' } };
      expect(shouldScanTranscript(event)).toBe(true);
    }
  });

  it('is false for tool_start, other harnesses, or a missing transcript path', () => {
    expect(shouldScanTranscript({ kind: 'tool_start', transcriptPath: '/t.jsonl', meta: { harness: 'claude-code' } })).toBe(false);
    expect(shouldScanTranscript({ kind: 'tool_end', transcriptPath: '/t.jsonl', meta: { harness: 'codex' } })).toBe(false);
    expect(shouldScanTranscript({ kind: 'tool_end', meta: { harness: 'claude-code' } })).toBe(false);
  });
});

describe('emitTranscriptLlmUsage', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aer-cc-transcript-'));
    file = path.join(dir, 't.jsonl');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('emits llm.completed for each new assistant turn, filtered through the ingest allowlist', () => {
    fs.writeFileSync(file, assistantLine('msg_1', 'a1', { inTok: 12, outTok: 340 }) + '\n');
    const { sink, seen } = collectingSink();
    const result = emitTranscriptLlmUsage(toolEndEvent(file), sink, {}, 'hs-1');

    expect(seen).toHaveLength(1);
    expect(seen[0]!.type).toBe('llm.completed');
    expect(seen[0]!.payload).toMatchObject({ model: 'claude-opus-4-8', provider: 'anthropic', input_tokens: 12, output_tokens: 340 });
    for (const key of Object.keys(seen[0]!.payload)) expect(INGEST_PAYLOAD_KEYS.has(key)).toBe(true);
    expect(result.emitted).toBe(1);
    expect(result.state.transcriptPath).toBe(file);
    expect(result.state.transcriptOffset).toBeGreaterThan(0);
    expect(result.state.emittedLlmMessageIds).toEqual(['msg_1']);
  });

  it('never puts message text or tool content on the wire', () => {
    fs.writeFileSync(file, assistantLine('msg_1', 'a1') + '\n');
    const { sink, seen } = collectingSink();
    emitTranscriptLlmUsage(toolEndEvent(file), sink, {}, 'hs-1');
    expect(JSON.stringify(seen)).not.toContain('SECRET-COMPLETION-TEXT');
  });

  it('gives every emitted event a deterministic id, stable across calls', () => {
    fs.writeFileSync(file, assistantLine('msg_1', 'a1') + '\n');
    const { sink, seen } = collectingSink();
    emitTranscriptLlmUsage(toolEndEvent(file), sink, {}, 'hs-1');
    const first = seen[0]!.id;
    expect(first).toBeTruthy();

    fs.writeFileSync(file, assistantLine('msg_1', 'a1') + '\n');
    const { sink: sink2, seen: seen2 } = collectingSink();
    emitTranscriptLlmUsage(toolEndEvent(file), sink2, {}, 'hs-1');
    expect(seen2[0]!.id).toBe(first);
  });

  it('is incremental across two calls sharing persisted state', () => {
    fs.writeFileSync(file, assistantLine('msg_1', 'a1') + '\n');
    const { sink: sink1, seen: seen1 } = collectingSink();
    const first = emitTranscriptLlmUsage(toolEndEvent(file), sink1, {}, 'hs-1');

    fs.appendFileSync(file, assistantLine('msg_2', 'a2') + '\n');
    const { sink: sink2, seen: seen2 } = collectingSink();
    const second = emitTranscriptLlmUsage(toolEndEvent(file), sink2, first.state, 'hs-1');

    expect(seen1).toHaveLength(1);
    expect(seen2).toHaveLength(1);
    expect(seen2[0]!.payload['model']).toBe('claude-opus-4-8');
    expect(second.state.emittedLlmMessageIds).toEqual(['msg_1', 'msg_2']);
  });

  it('does not re-emit a message id carried over from a prior invocation', () => {
    fs.writeFileSync(file, assistantLine('msg_1', 'a1') + '\n');
    const { sink, seen } = collectingSink();
    const result = emitTranscriptLlmUsage(toolEndEvent(file), sink, { transcriptPath: file, transcriptOffset: 0, emittedLlmMessageIds: ['msg_1'] }, 'hs-1');
    expect(seen).toHaveLength(0);
    expect(result.emitted).toBe(0);
  });

  it('resets prior offset/ids when the event references a different transcript path', () => {
    fs.writeFileSync(file, assistantLine('msg_new', 'a1') + '\n');
    const { sink, seen } = collectingSink();
    const result = emitTranscriptLlmUsage(toolEndEvent(file), sink, { transcriptPath: '/old/other.jsonl', transcriptOffset: 999, emittedLlmMessageIds: ['msg_new'] }, 'hs-1');
    // A different file means "msg_new" there is unrelated to this one.
    expect(seen).toHaveLength(1);
    expect(result.state.transcriptPath).toBe(file);
  });

  it('does nothing and returns the prior state unchanged for a non-triggering event', () => {
    const { sink, seen } = collectingSink();
    const prior = { transcriptPath: file, transcriptOffset: 3, emittedLlmMessageIds: ['a'] };
    const result = emitTranscriptLlmUsage({ kind: 'tool_start', transcriptPath: file, meta: { harness: 'claude-code' } }, sink, prior, 'hs-1');
    expect(seen).toHaveLength(0);
    expect(result).toEqual({ emitted: 0, state: prior });
  });

  it('is silent (no throw, no emit) when the transcript is missing', () => {
    const { sink, seen } = collectingSink();
    const result = emitTranscriptLlmUsage(toolEndEvent(path.join(dir, 'gone.jsonl')), sink, {}, 'hs-1');
    expect(seen).toHaveLength(0);
    expect(result.emitted).toBe(0);
  });

  it('bounds the persisted emittedLlmMessageIds list', () => {
    let content = '';
    for (let i = 0; i < 5; i++) content += assistantLine(`msg_${i}`, `u${i}`) + '\n';
    fs.writeFileSync(file, content);
    const { sink } = collectingSink();
    const result = emitTranscriptLlmUsage(toolEndEvent(file), sink, { emittedLlmMessageIds: ['old_a', 'old_b'] }, 'hs-1');
    expect(result.state.emittedLlmMessageIds!.length).toBeLessThanOrEqual(302);
  });
});
