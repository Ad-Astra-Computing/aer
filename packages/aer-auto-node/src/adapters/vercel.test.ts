import { describe, it, expect } from 'vitest';
import { vercelConfig, installVercelAdapter } from './vercel.js';
import type { CollectorEvent } from '../session.js';

describe('vercelConfig extractors', () => {
  it('extracts modelId + tool count from generateText params (model is an object)', () => {
    const req = vercelConfig(false).extractRequest([{
      model: { modelId: 'gpt-4o', provider: 'openai.chat' },
      tools: { get_weather: {}, search: {} },
    }]);
    expect(req).toEqual({ provider: 'vercel', model: 'gpt-4o', tools_available: 2 });
  });

  it('accepts a plain string model and returns null without one', () => {
    expect(vercelConfig(false).extractRequest([{ model: 'claude-opus-4' }])).toEqual({ provider: 'vercel', model: 'claude-opus-4' });
    expect(vercelConfig(false).extractRequest([{ prompt: 'hi' }])).toBeNull();
  });

  it('extracts usage, finishReason, and toolCall names from a generateText result', () => {
    const res = vercelConfig(false).extractResponse({
      text: 'secret model text',
      usage: { inputTokens: 100, outputTokens: 20 },
      finishReason: 'tool-calls',
      toolCalls: [{ toolName: 'get_weather', args: { city: 'oslo' } }],
    });
    expect(res).toEqual({ input_tokens: 100, output_tokens: 20, stop_reason: 'tool-calls', tool_names: ['get_weather'] });
    // never leak generated text or tool args
    expect(JSON.stringify(res)).not.toContain('secret model text');
    expect(JSON.stringify(res)).not.toContain('oslo');
  });

  it('supports the promptTokens/completionTokens usage shape', () => {
    const res = vercelConfig(false).extractResponse({ usage: { promptTokens: 7, completionTokens: 3 }, finishReason: 'stop', toolCalls: [] });
    expect(res).toMatchObject({ input_tokens: 7, output_tokens: 3, stop_reason: 'stop' });
  });

  it('streaming config never reads the result (usage is a promise in v1)', () => {
    expect(vercelConfig(true).extractResponse({ usage: Promise.resolve({}), finishReason: Promise.resolve('stop') })).toBeNull();
  });
});

function capt() {
  const events: CollectorEvent[] = [];
  return { capture: (e: CollectorEvent) => events.push(e), events };
}

// Flush enough microtasks for a Promise.allSettled-based observer to settle.
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe('vercel streaming result observation (v1.1)', () => {
  it('reads usage/finishReason/toolCalls promises and emits one completion', async () => {
    const { capture, events } = capt();
    const mod = {
      streamText: (_p: unknown) => ({
        // content streams the host would consume - MUST NOT be read by us
        get textStream() { throw new Error('textStream must not be read'); },
        get fullStream() { throw new Error('fullStream must not be read'); },
        usage: Promise.resolve({ inputTokens: 50, outputTokens: 12 }),
        finishReason: Promise.resolve('tool-calls'),
        toolCalls: Promise.resolve([{ toolName: 'search', args: { q: 'sensitive' } }]),
      }),
    };
    const { uninstall } = installVercelAdapter(capture, { resolveProto: () => mod });

    mod.streamText({ model: { modelId: 'gpt-4o' } });
    await flush();

    const completed = events.find((e) => e.event_type === 'llm.completed');
    expect(completed?.payload).toMatchObject({
      provider: 'vercel', ok: true, streaming: true, input_tokens: 50, output_tokens: 12,
      stop_reason: 'tool-calls', usage_observed: true,
    });
    const tools = events.filter((e) => e.event_type === 'tool.selected').map((e) => e.payload['tool']);
    expect(tools).toEqual(['search']);
    // tool args / content never captured
    expect(JSON.stringify(events)).not.toContain('sensitive');
    uninstall();
  });

  it('emits usage_observed:false when usage is missing (only finishReason resolves)', async () => {
    const { capture, events } = capt();
    const mod = { streamText: (_p: unknown) => ({ finishReason: Promise.resolve('stop'), textStream: {} }) };
    const { uninstall } = installVercelAdapter(capture, { resolveProto: () => mod });
    mod.streamText({ model: { modelId: 'm' } });
    await flush();
    const completed = events.find((e) => e.event_type === 'llm.completed');
    expect(completed?.payload).toMatchObject({ streaming: true, ok: true, stop_reason: 'stop', usage_observed: false });
    expect(completed?.payload['input_tokens']).toBeUndefined();
    uninstall();
  });

  it('survives a rejected usage promise and still reports the other settled fields', async () => {
    const { capture, events } = capt();
    const mod = {
      streamText: (_p: unknown) => ({
        usage: Promise.reject(new Error('usage failed')),
        finishReason: Promise.resolve('stop'),
        toolCalls: Promise.resolve([{ toolName: 'fetch' }]),
        textStream: {},
      }),
    };
    const { uninstall } = installVercelAdapter(capture, { resolveProto: () => mod });
    mod.streamText({ model: { modelId: 'm' } });
    await flush();
    const completed = events.find((e) => e.event_type === 'llm.completed');
    // usage promise rejected → no tokens → usage_observed:false, but stop_reason
    // and the tool name (from the other settled promises) are still reported.
    expect(completed?.payload).toMatchObject({ streaming: true, ok: true, stop_reason: 'stop', usage_observed: false });
    expect(events.filter((e) => e.event_type === 'tool.selected').map((e) => e.payload['tool'])).toEqual(['fetch']);
    uninstall();
  });

  it('extractStreamResult returns null for a non-streaming-shaped value', async () => {
    const cfg = vercelConfig(true);
    expect(cfg.extractStreamResult).toBeTypeOf('function');
    await expect(cfg.extractStreamResult!({ usage: { inputTokens: 1 } })).resolves.toBeNull(); // plain object, no promises
    await expect(cfg.extractStreamResult!(null)).resolves.toBeNull();
  });

  it('non-streaming config has no extractStreamResult hook', () => {
    expect(vercelConfig(false).extractStreamResult).toBeUndefined();
  });
});

describe('installVercelAdapter', () => {
  it('patches generateText + streamText on the resolved module and emits events', async () => {
    const mod = {
      generateText: async (_p: unknown) => ({ usage: { inputTokens: 1, outputTokens: 2 }, finishReason: 'stop', toolCalls: [] }),
      streamText: (_p: unknown) => ({ textStream: {}, usage: Promise.resolve({}) }),
    };
    const { capture, events } = capt();
    const { enabled, uninstall } = installVercelAdapter(capture, { resolveProto: () => mod });
    expect(enabled).toBe(true);

    await mod.generateText({ model: { modelId: 'gpt-4o' } });
    await Promise.resolve();
    expect(events.map((e) => e.event_type)).toEqual(['llm.requested', 'llm.completed']);
    expect(events[1]?.payload).toMatchObject({ provider: 'vercel', input_tokens: 1, output_tokens: 2 });

    events.length = 0;
    mod.streamText({ model: { modelId: 'gpt-4o' } });
    await Promise.resolve();
    expect(events[0]?.payload).toMatchObject({ provider: 'vercel', streaming: true });
    // completion is deferred until the result's usage promise settles
    await flush();
    const completed = events.find((e) => e.event_type === 'llm.completed');
    expect(completed?.payload).toMatchObject({ streaming: true, ok: true, model: 'gpt-4o', usage_observed: false });

    uninstall();
    expect(mod.generateText.name).not.toBe('wrapped'); // restored
  });

  it('reports enabled:false when the SDK is not resolvable', () => {
    const { capture } = capt();
    const { enabled, uninstall } = installVercelAdapter(capture, { resolveProto: () => null });
    expect(enabled).toBe(false);
    expect(() => uninstall()).not.toThrow();
  });
});
