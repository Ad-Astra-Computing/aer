// emitTranscriptLlmUsageForCodex wires tailCodexTranscript's output into the
// sink, filtered through the same ingest allowlist as every other hook
// event. This is the piece cli.ts calls once per hook invocation, alongside
// (not instead of) claude-code-transcript.ts's version.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EventSink } from '@adastracomputing/aer-emit';
import type { HookEvent } from './normalize.js';
import { shouldScanCodexTranscript, emitTranscriptLlmUsageForCodex } from './codex-transcript.js';
import { INGEST_PAYLOAD_KEYS } from './shared/ingest-allowlist.js';

function tokenUsageRecordLine(responseId: string, opts: Partial<{ turnId: string; inTok: number; outTok: number }> = {}): string {
  const usage = { input_tokens: opts.inTok ?? 4, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: opts.outTok ?? 6, reasoning_output_tokens: 0, total_tokens: (opts.inTok ?? 4) + (opts.outTok ?? 6) };
  return JSON.stringify({
    timestamp: '2026-10-12T00:00:00.000Z',
    type: 'token_usage_record',
    payload: { thread_id: 'thr_1', turn_id: opts.turnId ?? 'turn_1', session_id: 'ses_1', root_turn_id: opts.turnId ?? 'turn_1', response_id: responseId, usage, turn_token_usage: usage, thread_token_usage: usage },
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

function toolEndEvent(transcriptPath: string, model = 'gpt-5.1-codex'): HookEvent {
  return { kind: 'tool_end', tool: 'shell', ok: true, sessionRef: 'hs-1', transcriptPath, meta: { harness: 'codex', model } };
}

describe('shouldScanCodexTranscript', () => {
  it('is true for codex tool_end/turn_end/session_end with a transcript path', () => {
    for (const kind of ['tool_end', 'turn_end', 'session_end'] as const) {
      const event: HookEvent = { kind, transcriptPath: '/t.jsonl', meta: { harness: 'codex' } };
      expect(shouldScanCodexTranscript(event)).toBe(true);
    }
  });

  it('is false for tool_start, other harnesses, or a missing transcript path', () => {
    expect(shouldScanCodexTranscript({ kind: 'tool_start', transcriptPath: '/t.jsonl', meta: { harness: 'codex' } })).toBe(false);
    expect(shouldScanCodexTranscript({ kind: 'tool_end', transcriptPath: '/t.jsonl', meta: { harness: 'claude-code' } })).toBe(false);
    expect(shouldScanCodexTranscript({ kind: 'tool_end', meta: { harness: 'codex' } })).toBe(false);
  });
});

describe('emitTranscriptLlmUsageForCodex', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aer-codex-usage-'));
    file = path.join(dir, 'rollout.jsonl');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('emits llm.completed with the model from the hook event (not the rollout), filtered through the ingest allowlist', () => {
    fs.writeFileSync(file, tokenUsageRecordLine('resp_1', { inTok: 12, outTok: 340 }) + '\n');
    const { sink, seen } = collectingSink();
    const result = emitTranscriptLlmUsageForCodex(toolEndEvent(file), sink, {}, 'hs-1');

    expect(seen).toHaveLength(1);
    expect(seen[0]!.type).toBe('llm.completed');
    expect(seen[0]!.payload).toMatchObject({
      model: 'gpt-5.1-codex', provider: 'openai', input_tokens: 12, output_tokens: 340, turn_id: 'turn_1',
    });
    for (const key of Object.keys(seen[0]!.payload)) expect(INGEST_PAYLOAD_KEYS.has(key)).toBe(true);
    expect(result.emitted).toBe(1);
    expect(result.state.transcriptPath).toBe(file);
    expect(result.state.transcriptOffset).toBeGreaterThan(0);
    expect(result.state.emittedLlmMessageIds).toEqual(['resp_1']);
  });

  it('skips emission entirely when the triggering hook event has no usable model, rather than sending a record missing a required field', () => {
    fs.writeFileSync(file, tokenUsageRecordLine('resp_1') + '\n');
    const { sink, seen } = collectingSink();
    const noModel: HookEvent = { kind: 'tool_end', transcriptPath: file, sessionRef: 'hs-1', meta: { harness: 'codex' } };
    const result = emitTranscriptLlmUsageForCodex(noModel, sink, {}, 'hs-1');
    expect(seen).toHaveLength(0);
    expect(result.emitted).toBe(0);
  });

  it('is incremental across two calls sharing persisted state', () => {
    fs.writeFileSync(file, tokenUsageRecordLine('resp_1') + '\n');
    const { sink: sink1, seen: seen1 } = collectingSink();
    const first = emitTranscriptLlmUsageForCodex(toolEndEvent(file), sink1, {}, 'hs-1');

    fs.appendFileSync(file, tokenUsageRecordLine('resp_2') + '\n');
    const { sink: sink2, seen: seen2 } = collectingSink();
    const second = emitTranscriptLlmUsageForCodex(toolEndEvent(file), sink2, first.state, 'hs-1');

    expect(seen1).toHaveLength(1);
    expect(seen2).toHaveLength(1);
    expect(second.state.emittedLlmMessageIds).toEqual(['resp_1', 'resp_2']);
  });

  it('does not re-emit a response id carried over from a prior invocation', () => {
    fs.writeFileSync(file, tokenUsageRecordLine('resp_1') + '\n');
    const { sink: sink1 } = collectingSink();
    const first = emitTranscriptLlmUsageForCodex(toolEndEvent(file), sink1, {}, 'hs-1');

    const { sink: sink2, seen: seen2 } = collectingSink();
    const second = emitTranscriptLlmUsageForCodex(toolEndEvent(file), sink2, first.state, 'hs-1');
    expect(seen2).toHaveLength(0);
    expect(second.state.emittedLlmMessageIds).toEqual(['resp_1']);
  });

  it('gives every emitted event a deterministic id, stable across calls', () => {
    fs.writeFileSync(file, tokenUsageRecordLine('resp_1') + '\n');
    const { sink: sinkA, seen: seenA } = collectingSink();
    emitTranscriptLlmUsageForCodex(toolEndEvent(file), sinkA, {}, 'hs-1');
    const first = seenA[0]!.id;
    expect(first).toBeTruthy();

    fs.writeFileSync(file, tokenUsageRecordLine('resp_1') + '\n');
    const { sink: sinkB, seen: seenB } = collectingSink();
    emitTranscriptLlmUsageForCodex(toolEndEvent(file), sinkB, {}, 'hs-1');
    expect(seenB[0]!.id).toBe(first);
  });

  it('never puts a response_item or any prose off the rollout on the wire', () => {
    const responseItem = JSON.stringify({ timestamp: '2026-10-12T00:00:00.000Z', type: 'response_item', payload: { content: [{ type: 'input_text', text: 'SECRET-PROMPT' }] } });
    fs.writeFileSync(file, responseItem + '\n' + tokenUsageRecordLine('resp_1') + '\n');
    const { sink, seen } = collectingSink();
    emitTranscriptLlmUsageForCodex(toolEndEvent(file), sink, {}, 'hs-1');
    expect(JSON.stringify(seen)).not.toContain('SECRET-PROMPT');
  });
});
