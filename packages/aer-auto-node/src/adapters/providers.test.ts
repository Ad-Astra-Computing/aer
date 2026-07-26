import { describe, it, expect } from 'vitest';
import { openaiConfig, installOpenAIAdapter } from './openai.js';
import { anthropicConfig, installAnthropicAdapter } from './anthropic.js';
import type { StreamAccumulator } from './stream-tap.js';
import type { CollectorEvent } from '../session.js';

function foldAll(cfg: { extractStreamChunk?: (c: unknown, a: StreamAccumulator) => void }, chunks: unknown[]): StreamAccumulator {
  const acc: StreamAccumulator = { tool_names: [], chunks: 0 };
  for (const c of chunks) { acc.chunks++; cfg.extractStreamChunk?.(c, acc); }
  return acc;
}

describe('openaiConfig extractors', () => {
  it('extracts model + streaming + tool count from request params', () => {
    expect(openaiConfig.extractRequest([{ model: 'gpt-4o', stream: true, tools: [{}, {}] }])).toEqual({
      provider: 'openai', model: 'gpt-4o', streaming: true, tools_available: 2,
    });
    expect(openaiConfig.extractRequest([{ messages: [] }])).toBeNull();
  });

  it('extracts usage, finish_reason, and tool-call names from a chat completion', () => {
    const res = openaiConfig.extractResponse({
      model: 'gpt-4o-2024',
      usage: { prompt_tokens: 50, completion_tokens: 12 },
      choices: [{
        finish_reason: 'tool_calls',
        message: { tool_calls: [{ function: { name: 'get_weather', arguments: '{"city":"oslo"}' } }] },
      }],
    });
    expect(res).toEqual({
      model: 'gpt-4o-2024', input_tokens: 50, output_tokens: 12, stop_reason: 'tool_calls', tool_names: ['get_weather'],
    });
    // arguments must never appear in extracted metadata
    expect(JSON.stringify(res)).not.toContain('oslo');
  });

  it('returns null for a non-completion object (e.g. a stream)', () => {
    expect(openaiConfig.extractResponse({ [Symbol.asyncIterator]: () => ({}) })).toBeNull();
  });

  it('folds streaming chunks: tool name on its opening delta, usage on the final chunk', () => {
    const acc = foldAll(openaiConfig, [
      { model: 'gpt-4o-2024', choices: [{ delta: { role: 'assistant' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'get_weather', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"oslo"}' } }] } }] },
      { choices: [{ finish_reason: 'tool_calls', delta: {} }] },
      { choices: [], usage: { prompt_tokens: 40, completion_tokens: 9 } },
    ]);
    expect(acc).toMatchObject({
      model: 'gpt-4o-2024', input_tokens: 40, output_tokens: 9, stop_reason: 'tool_calls', tool_names: ['get_weather'],
    });
    // streamed tool arguments must never be captured
    expect(JSON.stringify(acc)).not.toContain('oslo');
  });
});

describe('anthropicConfig extractors', () => {
  it('extracts model + streaming + tool count from request params', () => {
    expect(anthropicConfig.extractRequest([{ model: 'claude-opus-4', stream: false, tools: [{}] }])).toEqual({
      provider: 'anthropic', model: 'claude-opus-4', tools_available: 1,
    });
  });

  it('extracts usage, stop_reason, and tool_use names from a messages response', () => {
    const res = anthropicConfig.extractResponse({
      model: 'claude-opus-4-8',
      stop_reason: 'tool_use',
      usage: { input_tokens: 200, output_tokens: 35 },
      content: [
        { type: 'text', text: 'secret thoughts' },
        { type: 'tool_use', name: 'search_docs', input: { q: 'sensitive' } },
      ],
    });
    expect(res).toEqual({
      model: 'claude-opus-4-8', input_tokens: 200, output_tokens: 35, stop_reason: 'tool_use', tool_names: ['search_docs'],
    });
    expect(JSON.stringify(res)).not.toContain('secret thoughts');
    expect(JSON.stringify(res)).not.toContain('sensitive');
  });

  it('folds the message stream: input on message_start, output+stop on message_delta, tool name on content_block_start', () => {
    const acc = foldAll(anthropicConfig, [
      { type: 'message_start', message: { model: 'claude-opus-4-8', usage: { input_tokens: 210 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'search_docs', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":"sensitive"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 33 } },
      { type: 'message_stop' },
    ]);
    expect(acc).toMatchObject({
      model: 'claude-opus-4-8', input_tokens: 210, output_tokens: 33, stop_reason: 'tool_use', tool_names: ['search_docs'],
    });
    // streamed tool-input JSON must never be captured
    expect(JSON.stringify(acc)).not.toContain('sensitive');
  });
});

describe('install via injected prototype', () => {
  function capt() {
    const events: CollectorEvent[] = [];
    return { capture: (e: CollectorEvent) => events.push(e), events };
  }

  it('installOpenAIAdapter patches the resolved prototype create and emits events', async () => {
    const proto = { create: async (_p: unknown) => ({ model: 'gpt-4o', usage: { prompt_tokens: 1, completion_tokens: 2 }, choices: [] }) };
    const { capture, events } = capt();
    const { enabled, uninstall } = installOpenAIAdapter(capture, { resolveProto: () => proto });
    expect(enabled).toBe(true);

    await proto.create({ model: 'gpt-4o' });
    await Promise.resolve();
    expect(events.map((e) => e.event_type)).toEqual(['llm.requested', 'llm.completed']);
    expect(events[1]?.payload).toMatchObject({ provider: 'openai', input_tokens: 1, output_tokens: 2 });
    uninstall();
    expect(events.length).toBe(2); // calls after uninstall are not captured
    await proto.create({ model: 'gpt-4o' });
    await Promise.resolve();
    expect(events.length).toBe(2);
  });

  it('reports enabled:false and a no-op uninstall when the SDK is not resolvable', () => {
    const { capture } = capt();
    const { enabled, uninstall } = installAnthropicAdapter(capture, { resolveProto: () => null });
    expect(enabled).toBe(false);
    expect(() => uninstall()).not.toThrow();
  });
});
