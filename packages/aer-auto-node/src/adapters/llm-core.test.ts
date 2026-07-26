import { describe, it, expect } from 'vitest';
import { wrapCreate, patchMethod, type ProviderConfig } from './llm-core.js';
import { openaiConfig } from './openai.js';
import { commitmentKeyFromString, deriveKid, canonicalizeRequest, promptCanonTag, responseTag, wireBodyTag, toolArgsTag, toolResultTag, CANON_VERSION } from '../commitment.js';
import type { CollectorEvent } from '../session.js';

// A minimal provider config for exercising the generic wrapper.
const cfg: ProviderConfig = {
  provider: 'testllm',
  extractRequest: (args) => {
    const p = args[0] as { model?: string; stream?: boolean; tools?: unknown[] } | undefined;
    if (!p?.model) return null;
    return {
      provider: 'testllm',
      model: p.model,
      ...(p.stream ? { streaming: true } : {}),
      ...(Array.isArray(p.tools) ? { tools_available: p.tools.length } : {}),
    };
  },
  extractResponse: (response) => {
    const r = response as { model?: string; usage?: { in?: number; out?: number }; stop?: string; tools?: string[] } | null;
    if (!r || typeof r !== 'object' || !('usage' in r)) return null;
    return {
      ...(r.model ? { model: r.model } : {}),
      ...(r.usage?.in != null ? { input_tokens: r.usage.in } : {}),
      ...(r.usage?.out != null ? { output_tokens: r.usage.out } : {}),
      ...(r.stop ? { stop_reason: r.stop } : {}),
      tool_names: r.tools ?? [],
    };
  },
};

function capt() {
  const events: CollectorEvent[] = [];
  return { capture: (e: CollectorEvent) => events.push(e), events };
}

describe('wrapCreate', () => {
  it('emits llm.requested then llm.completed with token + stop metadata', async () => {
    const { capture, events } = capt();
    const original = async () => ({ model: 'gpt-x', usage: { in: 100, out: 20 }, stop: 'stop', tools: [] });
    const wrapped = wrapCreate(original, cfg, capture);

    await wrapped({ model: 'gpt-x' });
    // allow the observe-then microtask to flush
    await Promise.resolve();

    const types = events.map((e) => e.event_type);
    expect(types).toEqual(['llm.requested', 'llm.completed']);
    expect(events[0]?.payload).toMatchObject({ provider: 'testllm', model: 'gpt-x' });
    expect(events[1]?.payload).toMatchObject({
      provider: 'testllm', model: 'gpt-x', input_tokens: 100, output_tokens: 20, stop_reason: 'stop', ok: true,
    });
  });

  it('emits tool.selected (names only) for each tool call in the response', async () => {
    const { capture, events } = capt();
    const original = async () => ({ model: 'm', usage: { in: 1, out: 1 }, tools: ['get_weather', 'search'] });
    const wrapped = wrapCreate(original, cfg, capture);
    await wrapped({ model: 'm' });
    await Promise.resolve();

    const tools = events.filter((e) => e.event_type === 'tool.selected').map((e) => e.payload['tool']);
    expect(tools).toEqual(['get_weather', 'search']);
    // never leak arguments — only the name + provider
    const toolEv = events.find((e) => e.event_type === 'tool.selected');
    expect(Object.keys(toolEv!.payload).sort()).toEqual(['provider', 'tool']);
  });

  it('marks streaming requests and does not consume the stream object', async () => {
    const { capture, events } = capt();
    const fakeStream = { [Symbol.asyncIterator]: () => { throw new Error('must not iterate'); } };
    const original = async () => fakeStream;
    const wrapped = wrapCreate(original, cfg, capture);

    const result = await wrapped({ model: 'm', stream: true });
    await Promise.resolve();

    expect(result).toBe(fakeStream); // returned untouched
    expect(events[0]?.payload['streaming']).toBe(true);
    // completed still emitted (best-effort), carrying the request model
    const completed = events.find((e) => e.event_type === 'llm.completed');
    expect(completed?.payload).toMatchObject({ model: 'm', streaming: true, ok: true });
  });

  it('returns the original result object untouched (preserves SDK promise value)', async () => {
    const { capture } = capt();
    const response = { model: 'm', usage: { in: 1, out: 1 }, extra: 'preserved' };
    const wrapped = wrapCreate(async () => response, cfg, capture);
    const out = await wrapped({ model: 'm' });
    expect(out).toBe(response);
    expect((out as { extra: string }).extra).toBe('preserved');
  });

  it('emits llm.completed with ok:false when the call rejects, and rethrows', async () => {
    const { capture, events } = capt();
    const wrapped = wrapCreate(async () => { throw new Error('rate limited'); }, cfg, capture);
    await expect(wrapped({ model: 'm' })).rejects.toThrow('rate limited');
    await Promise.resolve();
    const completed = events.find((e) => e.event_type === 'llm.completed');
    expect(completed?.payload).toMatchObject({ ok: false, error: true });
  });

  it('never throws into the host when capture throws', async () => {
    const wrapped = wrapCreate(async () => ({ model: 'm', usage: { in: 1, out: 1 } }), cfg, () => {
      throw new Error('capture boom');
    });
    await expect(wrapped({ model: 'm' })).resolves.toBeDefined();
  });
});

// A streaming-capable config: folds {out, tool} chunks, ignores chunk text.
const streamCfg: ProviderConfig = {
  ...cfg,
  extractStreamChunk: (chunk, acc) => {
    const c = chunk as { out?: number; tool?: string; text?: string };
    if (typeof c.out === 'number') acc.output_tokens = c.out;
    if (typeof c.tool === 'string' && !acc.tool_names.includes(c.tool)) acc.tool_names.push(c.tool);
    // c.text is content — intentionally never read.
  },
};

function makeStream(chunks: unknown[]): AsyncIterable<unknown> & { pulled: number } {
  const obj = {
    pulled: 0,
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      let i = 0;
      return {
        next: async (): Promise<IteratorResult<unknown>> => {
          obj.pulled++;
          return i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined };
        },
      };
    },
  };
  return obj as AsyncIterable<unknown> & { pulled: number };
}

describe('wrapCreate streaming (v1.1)', () => {
  it('defers llm.completed to stream end, with usage folded from chunks', async () => {
    const { capture, events } = capt();
    const stream = makeStream([{ out: 3, text: 'hello' }, { out: 7, tool: 'search', text: ' world' }]);
    const wrapped = wrapCreate(async () => stream, streamCfg, capture);

    const returned = await wrapped({ model: 'm', stream: true });
    await Promise.resolve();

    // At request time: only llm.requested — completion is NOT emitted yet.
    expect(events.map((e) => e.event_type)).toEqual(['llm.requested']);
    expect(events[0]?.payload).toMatchObject({ streaming: true });
    expect((returned as { pulled: number }).pulled).toBe(0); // not consumed yet

    // Host drains the stream.
    const seen: unknown[] = [];
    for await (const c of returned as AsyncIterable<unknown>) seen.push(c);

    const completed = events.find((e) => e.event_type === 'llm.completed');
    expect(completed?.payload).toMatchObject({
      provider: 'testllm', ok: true, streaming: true, output_tokens: 7, usage_observed: true,
    });
    expect(typeof completed?.payload['duration_ms']).toBe('number');
    const tools = events.filter((e) => e.event_type === 'tool.selected').map((e) => e.payload['tool']);
    expect(tools).toEqual(['search']);
    // never leak chunk content
    expect(JSON.stringify(events)).not.toContain('hello');
    expect(JSON.stringify(events)).not.toContain('world');
  });

  it('emits completion with usage_observed:false when no chunk carried usage', async () => {
    const { capture, events } = capt();
    const stream = makeStream([{ text: 'a' }, { text: 'b' }]);
    const wrapped = wrapCreate(async () => stream, streamCfg, capture);
    const returned = await wrapped({ model: 'm', stream: true });
    for await (const _c of returned as AsyncIterable<unknown>) { /* drain */ }

    const completed = events.find((e) => e.event_type === 'llm.completed');
    expect(completed?.payload).toMatchObject({ streaming: true, ok: true, usage_observed: false });
    expect(completed?.payload['output_tokens']).toBeUndefined();
  });

  it('records call + ok in stats once per streamed response', async () => {
    const { capture } = capt();
    const { AdapterStats } = await import('./stats.js');
    const stats = new AdapterStats();
    const stream = makeStream([{ out: 1, tool: 'search' }]);
    const wrapped = wrapCreate(async () => stream, streamCfg, capture, stats);
    const returned = await wrapped({ model: 'm', stream: true });
    for await (const _c of returned as AsyncIterable<unknown>) { /* drain */ }

    expect(stats.snapshot()).toEqual({ testllm: { calls: 1, ok: 1, error: 0, tool_selections: 1 } });
  });

  it('falls back to a best-effort completion when the resolved value is not iterable', async () => {
    const { capture, events } = capt();
    const wrapped = wrapCreate(async () => ({ not: 'iterable' }), streamCfg, capture);
    await wrapped({ model: 'm', stream: true });
    await Promise.resolve();
    const completed = events.find((e) => e.event_type === 'llm.completed');
    expect(completed?.payload).toMatchObject({ streaming: true, ok: true, usage_observed: false });
  });
});

describe('patchMethod', () => {
  it('wraps a method, is idempotent, and restores on uninstall', () => {
    const obj = { create: (x: number) => x + 1 };
    const original = obj.create;
    const make = (orig: typeof original) => ((x: number) => orig(x) * 10) as typeof original;

    const u1 = patchMethod(obj, 'create', make, 'testkey');
    const u2 = patchMethod(obj, 'create', make, 'testkey'); // idempotent no-op
    expect(obj.create(1)).toBe(20);
    u2(); u1();
    expect(obj.create).toBe(original);
  });

  it('returns a no-op when the target method is missing', () => {
    const obj = {} as { create?: () => void };
    const uninstall = patchMethod(obj as { create: () => void }, 'create', (o) => o, 'k');
    expect(typeof uninstall).toBe('function');
    expect(() => uninstall()).not.toThrow();
  });
});

describe('wrapCreate — content commitment (ADR-009)', () => {
  const KEY = commitmentKeyFromString('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff')!;
  const commit = { key: KEY, kid: deriveKid(KEY) };
  const req = {
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi there.' },
    ],
  };
  const okResponse = {
    model: 'gpt-4o',
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }],
  };

  it('emits llm.prompt_committed (tag only) between requested and completed', async () => {
    const { capture, events } = capt();
    const wrapped = wrapCreate(async () => okResponse, openaiConfig, capture, undefined, undefined, commit);
    await wrapped(req);
    await Promise.resolve();

    const types = events.map((e) => e.event_type);
    expect(types).toEqual(['llm.requested', 'llm.prompt_committed', 'llm.completed']);

    const committed = events[1]!.payload;
    expect(committed).toMatchObject({
      provider: 'openai',
      model: 'gpt-4o',
      kid: commit.kid,
      canon: CANON_VERSION,
      capture_point: 'adapter_request',
      message_count: 1, // system hoisted
      retained: 'none',
    });
    expect(committed['prompt_canon_tag']).toMatch(/^[0-9a-f]{64}$/);
    // The tag must equal an independent recompute over the canon of the request.
    const canon = canonicalizeRequest('openai', [req])!;
    expect(committed['prompt_canon_tag']).toBe(promptCanonTag(KEY, canon));
    // No prompt TEXT ever appears in the event.
    expect(JSON.stringify(committed)).not.toContain('Hi there');
    expect(JSON.stringify(committed)).not.toContain('helpful');
  });

  it('adds request_ref + response_tag + outcome to the completion (non-streaming)', async () => {
    const { capture, events } = capt();
    const wrapped = wrapCreate(async () => okResponse, openaiConfig, capture, undefined, undefined, commit);
    await wrapped(req);
    await Promise.resolve();

    const committed = events[1]!.payload;
    const completed = events[2]!.payload;
    expect(completed['request_ref']).toBe(committed['request_ref']); // correlated
    expect(completed['outcome']).toBe('ok');
    expect(completed['response_tag']).toBe(responseTag(KEY, 'Hello!'));
    expect(JSON.stringify(completed)).not.toContain('Hello!'); // text never emitted
  });

  it('emits NO commitment fields when no key is configured (byte-identical to before)', async () => {
    const { capture, events } = capt();
    const wrapped = wrapCreate(async () => okResponse, openaiConfig, capture);
    await wrapped(req);
    await Promise.resolve();
    expect(events.map((e) => e.event_type)).toEqual(['llm.requested', 'llm.completed']);
    const completed = events[1]!.payload;
    expect(completed['request_ref']).toBeUndefined();
    expect(completed['response_tag']).toBeUndefined();
    expect(completed['outcome']).toBeUndefined();
  });

  it('marks an error completion with outcome:error and no response_tag', async () => {
    const { capture, events } = capt();
    const wrapped = wrapCreate(async () => { throw new Error('boom'); }, openaiConfig, capture, undefined, undefined, commit);
    await expect(wrapped(req)).rejects.toThrow('boom');
    await Promise.resolve();
    const completed = events.find((e) => e.event_type === 'llm.completed')!.payload;
    expect(completed).toMatchObject({ ok: false, outcome: 'error', response_captured: false });
    expect(completed['response_tag']).toBeUndefined();
  });
});

describe('wrapCreate — content commitment slice 2 (ADR-011)', () => {
  const KEY = commitmentKeyFromString('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff')!;
  const commit = { key: KEY, kid: deriveKid(KEY) };

  it('adds a wire_canon_tag over the FULL body (sampling params included)', async () => {
    const { capture, events } = capt();
    const req = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], temperature: 0.7 };
    const wrapped = wrapCreate(async () => ({ choices: [{ message: { content: 'ok' } }] }), openaiConfig, capture, undefined, undefined, commit);
    await wrapped(req);
    await Promise.resolve();
    const committed = events.find((e) => e.event_type === 'llm.prompt_committed')!.payload;
    expect(committed['wire_canon']).toBe('aer-wire.v1');
    expect(committed['wire_canon_tag']).toBe(wireBodyTag(KEY, req));
    // The wire tag reflects sampling params the semantic prompt tag ignores.
    expect(committed['wire_canon_tag']).not.toBe(wireBodyTag(KEY, { ...req, temperature: 0.1 }));
    expect(JSON.stringify(committed)).not.toContain('hi'); // still no prompt text
  });

  it('commits tool-call arguments as tool_args_tag (args never emitted)', async () => {
    const { capture, events } = capt();
    const response = {
      choices: [{ message: { content: null, tool_calls: [{ function: { name: 'search', arguments: '{"q":"weather"}' } }] }, finish_reason: 'tool_calls' }],
    };
    const wrapped = wrapCreate(async () => response, openaiConfig, capture, undefined, undefined, commit);
    await wrapped({ model: 'gpt-4o', messages: [{ role: 'user', content: 'weather?' }] });
    await Promise.resolve();
    const tool = events.find((e) => e.event_type === 'tool.selected')!.payload;
    expect(tool['tool']).toBe('search');
    expect(tool['tool_args_tag']).toBe(toolArgsTag(KEY, 'search', '{"q":"weather"}'));
    // request_ref rides with the tag and matches the request's prompt commitment,
    // so the generator can correlate the tool-argument commitment server-side.
    const committed = events.find((e) => e.event_type === 'llm.prompt_committed')!.payload;
    expect(tool['request_ref']).toBe(committed['request_ref']);
    expect(typeof tool['request_ref']).toBe('string');
    expect(JSON.stringify(events)).not.toContain('weather'); // args + prompt never leak
  });

  it('commits tool RESULTS fed into the request as tool_result_tags', async () => {
    const { capture, events } = capt();
    // Distinctive sentinel content: a short numeric value like "72" collides with
    // hex digests and the random UUID request_ref, making the leak assertion flaky.
    const RESULT = '{"temp":"ZzSeNtNeLzZ"}';
    const req = {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: '' },
        { role: 'tool', tool_call_id: 'c1', content: RESULT },
      ],
    };
    const wrapped = wrapCreate(async () => ({ choices: [{ message: { content: 'ok' } }] }), openaiConfig, capture, undefined, undefined, commit);
    await wrapped(req);
    await Promise.resolve();
    const committed = events.find((e) => e.event_type === 'llm.prompt_committed')!.payload;
    expect(committed['tool_result_tags']).toEqual([toolResultTag(KEY, RESULT)]);
    expect(JSON.stringify(committed)).not.toContain('ZzSeNtNeLzZ'); // result content never emitted
  });

  it('captures a STREAMING response into a real response_tag (text never emitted)', async () => {
    const { capture, events } = capt();
    // OpenAI-style chunks with delta.content; assembled text = "Hello world".
    const chunks = [
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2 } },
    ];
    const stream = makeStream(chunks);
    const wrapped = wrapCreate(async () => stream, openaiConfig, capture, undefined, undefined, commit);
    const returned = await wrapped({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], stream: true });
    await Promise.resolve();
    for await (const _c of returned as AsyncIterable<unknown>) { void _c; }
    const completed = events.find((e) => e.event_type === 'llm.completed')!.payload;
    expect(completed['streaming']).toBe(true);
    expect(completed['outcome']).toBe('ok');
    expect(completed['response_tag']).toBe(responseTag(KEY, 'Hello world'));
    expect(completed['response_captured']).toBeUndefined(); // real tag, not the deferred marker
    expect(JSON.stringify(events)).not.toContain('Hello world'); // streamed text never leaks
  });

  it('stops accumulating a runaway stream and emits response_captured:false (no partial tag)', async () => {
    const { capture, events } = capt();
    // ~5 MiB of streamed text across chunks, over the 4 MiB commit cap.
    const big = 'x'.repeat(512 * 1024);
    const chunks = Array.from({ length: 10 }, () => ({ choices: [{ delta: { content: big } }] }));
    chunks.push({ choices: [{ delta: { content: 'z' }, finish_reason: 'stop' }] } as never);
    const stream = makeStream(chunks);
    const wrapped = wrapCreate(async () => stream, openaiConfig, capture, undefined, undefined, commit);
    const returned = await wrapped({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], stream: true });
    await Promise.resolve();
    for await (const _c of returned as AsyncIterable<unknown>) { void _c; }
    const completed = events.find((e) => e.event_type === 'llm.completed')!.payload;
    expect(completed['response_tag']).toBeUndefined();
    expect(completed['response_captured']).toBe(false); // truncated → no tag over partial text
  });

  it('streaming with no key still emits nothing sensitive and no response_tag', async () => {
    const { capture, events } = capt();
    const stream = makeStream([{ choices: [{ delta: { content: 'secret' }, finish_reason: 'stop' }] }]);
    const wrapped = wrapCreate(async () => stream, openaiConfig, capture);
    const returned = await wrapped({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], stream: true });
    await Promise.resolve();
    for await (const _c of returned as AsyncIterable<unknown>) { void _c; }
    const completed = events.find((e) => e.event_type === 'llm.completed')!.payload;
    expect(completed['response_tag']).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain('secret');
  });
});
