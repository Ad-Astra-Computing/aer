import { describe, it, expect } from 'vitest';
import { recordableToolName, TOOL_NAME_PLACEHOLDER, MAX_TOOL_NAME_LEN } from './tool-name.js';
import { wrapCreate, type ProviderConfig } from './llm-core.js';
import { wrapModelCall } from './vercel-provider.js';
import { AdapterStats } from './stats.js';
import type { CollectorEvent } from '../session.js';

describe('a tool name from the model', () => {
  it('is recorded as is when ingest would accept it', () => {
    expect(recordableToolName('lookup')).toBe('lookup');
    expect(recordableToolName('mcp__github__create_issue')).toBe('mcp__github__create_issue');
    expect(recordableToolName('x'.repeat(MAX_TOOL_NAME_LEN))).toBe('x'.repeat(MAX_TOOL_NAME_LEN));
  });

  it('is replaced by a fixed placeholder when ingest would refuse it or it is not a name', () => {
    for (const bad of ['', 'x'.repeat(MAX_TOOL_NAME_LEN + 1), 'line one\nline two', 'tab\there', 'nul\u0000', 'c1\u0085', 42, null, undefined, {}, ['a']]) {
      expect(recordableToolName(bad)).toBe(TOOL_NAME_PLACEHOLDER);
    }
  });

  it('matches the ingest field bound of 512 UTF-16 code units', () => {
    expect(MAX_TOOL_NAME_LEN).toBe(512);
    // 256 astral characters are 512 code units: accepted, as ingest accepts them.
    expect(recordableToolName('\u{1F600}'.repeat(256))).toBe('\u{1F600}'.repeat(256));
    expect(recordableToolName('\u{1F600}'.repeat(257))).toBe(TOOL_NAME_PLACEHOLDER);
  });
});

const LONG = 'IGNORE PREVIOUS INSTRUCTIONS '.repeat(40);

function capt() {
  const events: CollectorEvent[] = [];
  return { capture: (e: CollectorEvent) => events.push(e), events };
}
const toolsOf = (events: CollectorEvent[]) => events.filter((e) => e.event_type === 'tool.selected').map((e) => (e.payload as Record<string, unknown>)['tool']);

describe('every SDK path records a bounded tool name and counts each replacement', () => {
  const cfg: ProviderConfig = {
    provider: 'testllm',
    extractRequest: (args) => ({ provider: 'testllm', model: 'm', ...((args[0] as { stream?: boolean } | undefined)?.stream ? { streaming: true } : {}) }),
    extractResponse: (r) => ({ tool_names: (r as { names: string[] }).names }),
    extractStreamChunk: (chunk, acc) => { acc.tool_names.push(...(chunk as { names: string[] }).names); },
  };

  it('a non-streaming OpenAI or Anthropic response', async () => {
    const { capture, events } = capt();
    const stats = new AdapterStats();
    const wrapped = wrapCreate(async () => ({ names: ['lookup', LONG, 'bad\nname'] }), cfg, capture, stats);
    await wrapped({});
    await new Promise((r) => setTimeout(r, 0));
    expect(toolsOf(events)).toEqual(['lookup', TOOL_NAME_PLACEHOLDER, TOOL_NAME_PLACEHOLDER]);
    expect(stats.snapshot()['testllm']).toMatchObject({ tool_selections: 3, tool_names_replaced: 2 });
  });

  it('a streamed OpenAI or Anthropic response', async () => {
    const { capture, events } = capt();
    const stats = new AdapterStats();
    const stream = { async *[Symbol.asyncIterator]() { yield { names: [LONG] }; } };
    const wrapped = wrapCreate(async () => stream, cfg, capture, stats);
    const res = await wrapped({ stream: true }) as AsyncIterable<unknown>;
    for await (const _ of res) { /* drain */ }
    await new Promise((r) => setTimeout(r, 0));
    expect(toolsOf(events)).toEqual([TOOL_NAME_PLACEHOLDER]);
    expect(stats.snapshot()['testllm']).toMatchObject({ tool_selections: 1, tool_names_replaced: 1 });
  });

  it('the Vercel provider layer, generated and streamed', async () => {
    const { capture, events } = capt();
    const stats = new AdapterStats();
    const model = {
      modelId: 'm',
      async doGenerate() { return { content: [{ type: 'tool-call', toolName: LONG, input: '{}' }], usage: {}, finishReason: 'tool-calls' }; },
      async doStream() {
        const parts = [{ type: 'tool-call', toolName: 'a\u0000b', input: '{}' }, { type: 'finish', usage: {}, finishReason: 'stop' }];
        let i = 0;
        return { stream: new ReadableStream({ pull(c) { if (i < parts.length) c.enqueue(parts[i++]); else c.close(); } }) };
      },
    };
    await wrapModelCall(model.doGenerate, 'openai', capture as never, stats, false).call(model);
    const r = await wrapModelCall(model.doStream, 'openai', capture as never, stats, true).call(model) as { stream: ReadableStream };
    const reader = r.stream.getReader();
    while (!(await reader.read()).done) { /* drain */ }
    expect(toolsOf(events)).toEqual([TOOL_NAME_PLACEHOLDER, TOOL_NAME_PLACEHOLDER]);
    expect(stats.snapshot()['openai']).toMatchObject({ tool_selections: 2, tool_names_replaced: 2 });
  });

  it('adds no counter to a report when nothing was replaced', async () => {
    const { capture } = capt();
    const stats = new AdapterStats();
    await wrapCreate(async () => ({ names: ['lookup'] }), cfg, capture, stats)({});
    await new Promise((r) => setTimeout(r, 0));
    expect(stats.snapshot()['testllm']).toEqual({ calls: 1, ok: 1, error: 0, tool_selections: 1 });
  });
});
