import { describe, it, expect } from 'vitest';
import { tokenCount, finishReasonOf, wrapModelCall } from './vercel-provider.js';
import { AerPolicyError, PolicyEnforcer } from '../policy.js';
import type { PolicyOptionSource } from './llm-core.js';

describe('reading the provider-spec response', () => {
  // The v4 spec reports usage as an object and the finish reason as a pair.
  // Earlier versions reported a plain number and a plain string. Both are
  // read, so a customer on either version gets a complete record.
  it('reads a v4 token count', () => {
    expect(tokenCount({ total: 5, noCache: 5, cacheRead: 0 })).toBe(5);
  });

  it('reads an older bare token count', () => {
    expect(tokenCount(7)).toBe(7);
  });

  it('reports nothing rather than a wrong number', () => {
    for (const v of [undefined, null, {}, { total: 'five' }, -1, Number.NaN, 'five', []]) {
      expect(tokenCount(v)).toBeUndefined();
    }
  });

  it('reads a v4 finish reason, preferring the unified one', () => {
    expect(finishReasonOf({ unified: 'stop', raw: 'end_turn' })).toBe('stop');
    expect(finishReasonOf({ raw: 'end_turn' })).toBe('end_turn');
  });

  it('reads an older string finish reason', () => {
    expect(finishReasonOf('stop')).toBe('stop');
  });

  it('reports nothing for a shape it does not know', () => {
    for (const v of [undefined, null, {}, 42, []]) expect(finishReasonOf(v)).toBeUndefined();
  });
});

// A provider model shaped like the LanguageModel spec every @ai-sdk package
// implements: doGenerate resolves with usage, a finish reason and content
// parts; doStream resolves with a stream of parts ending in a finish part.
const USAGE = { inputTokens: { total: 11, noCache: 11 }, outputTokens: { total: 7, text: 7 } };
const SECRET = 'CANARY_SECRET_CONTENT';

class FakeModel {
  readonly modelId: string;
  calls = 0;
  pulls = 0;
  constructor(modelId = 'mx-model') { this.modelId = modelId; }
  async doGenerate(): Promise<unknown> {
    this.calls += 1;
    return {
      content: [{ type: 'text', text: SECRET }, { type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: JSON.stringify({ q: SECRET }) }],
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      usage: USAGE,
      response: { modelId: 'mx-model-2026' },
    };
  }
  async doStream(opts: { fail?: boolean; errorPart?: boolean } = {}): Promise<unknown> {
    this.calls += 1;
    const parts: unknown[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-delta', id: 't', delta: SECRET },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: JSON.stringify({ q: SECRET }) },
      ...(opts.errorPart ? [{ type: 'error', error: new Error('provider said no') }] : []),
      { type: 'finish', usage: USAGE, finishReason: { unified: 'stop', raw: 'stop' } },
    ];
    let i = 0;
    const stream = new ReadableStream<unknown>({
      pull: (controller) => {
        this.pulls += 1;
        if (opts.fail && i === 2) { controller.error(new Error('socket closed')); return; }
        if (i < parts.length) controller.enqueue(parts[i++]);
        else controller.close();
      },
    }, { highWaterMark: 0 });
    return { stream, request: {}, response: {} };
  }
}

function recorder() {
  const events: Array<{ event_type: string; payload: Record<string, unknown> }> = [];
  return { events, capture: (e: { event_type: string; payload?: Record<string, unknown> }) => { events.push({ event_type: e.event_type, payload: e.payload ?? {} }); } };
}

function wrap(model: FakeModel, method: 'doGenerate' | 'doStream', capture: (e: never) => void, policy?: PolicyOptionSource) {
  const orig = model[method] as (...a: unknown[]) => unknown;
  return wrapModelCall(orig, 'openai', capture as never, undefined, method === 'doStream', policy).bind(model) as (...a: unknown[]) => Promise<Record<string, unknown>>;
}

async function drain(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  const reader = stream.getReader();
  for (;;) {
    const r = await reader.read();
    if (r.done) return out;
    out.push(r.value);
  }
}

const types = (events: Array<{ event_type: string }>) => events.map((e) => e.event_type);

describe('doGenerate', () => {
  it('records usage, finish reason, the responded model and tool names, never content', async () => {
    const { events, capture } = recorder();
    const model = new FakeModel();
    await wrap(model, 'doGenerate', capture)({ prompt: [{ role: 'user', content: SECRET }] });
    expect(types(events)).toEqual(['llm.requested', 'llm.completed', 'tool.selected']);
    expect(events[1]!.payload).toEqual({ provider: 'openai', model: 'mx-model-2026', ok: true, input_tokens: 11, output_tokens: 7, stop_reason: 'tool-calls' });
    expect(events[2]!.payload).toEqual({ provider: 'openai', tool: 'lookup' });
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });
});

describe('doStream', () => {
  it('records the call when the host has read the stream, with tokens and tool names', async () => {
    const { events, capture } = recorder();
    const model = new FakeModel();
    const result = await wrap(model, 'doStream', capture)({});
    // Opened, not finished: nothing but the request yet.
    expect(types(events)).toEqual(['llm.requested']);
    const parts = await drain(result['stream'] as ReadableStream<unknown>);
    expect(parts.map((p) => (p as { type: string }).type)).toEqual(['stream-start', 'text-delta', 'tool-call', 'finish']);
    expect((parts[1] as { delta: string }).delta).toBe(SECRET);
    expect(types(events)).toEqual(['llm.requested', 'llm.completed', 'tool.selected']);
    expect(events[1]!.payload).toEqual({ provider: 'openai', model: 'mx-model', ok: true, streaming: true, usage_observed: true, input_tokens: 11, output_tokens: 7, stop_reason: 'stop' });
    expect(events[2]!.payload).toEqual({ provider: 'openai', tool: 'lookup' });
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it('never reads ahead of the host', async () => {
    const { capture } = recorder();
    const model = new FakeModel();
    const result = await wrap(model, 'doStream', capture)({});
    const reader = (result['stream'] as ReadableStream<unknown>).getReader();
    await reader.read();
    await new Promise((r) => setTimeout(r, 10));
    expect(model.pulls).toBe(1);
    await reader.cancel();
  });

  it('records a failed call once when the stream errors', async () => {
    const { events, capture } = recorder();
    const model = new FakeModel();
    const result = await wrap(model, 'doStream', capture)({ fail: true });
    await expect(drain(result['stream'] as ReadableStream<unknown>)).rejects.toThrow('socket closed');
    const done = events.filter((e) => e.event_type === 'llm.completed');
    expect(done).toHaveLength(1);
    expect(done[0]!.payload).toMatchObject({ ok: false, error: true, streaming: true });
  });

  it('records an error part as a failed call', async () => {
    const { events, capture } = recorder();
    const model = new FakeModel();
    const result = await wrap(model, 'doStream', capture)({ errorPart: true });
    await drain(result['stream'] as ReadableStream<unknown>);
    const done = events.filter((e) => e.event_type === 'llm.completed');
    expect(done).toHaveLength(1);
    expect(done[0]!.payload['ok']).toBe(false);
  });

  it('records what it saw once when the host stops reading early', async () => {
    const { events, capture } = recorder();
    const model = new FakeModel();
    const result = await wrap(model, 'doStream', capture)({});
    const reader = (result['stream'] as ReadableStream<unknown>).getReader();
    await reader.read();
    await reader.cancel('enough');
    await reader.cancel('again').catch(() => undefined);
    const done = events.filter((e) => e.event_type === 'llm.completed');
    expect(done).toHaveLength(1);
    expect(done[0]!.payload).toMatchObject({ ok: true, streaming: true, usage_observed: false });
  });
});

describe('usage policy at the provider layer', () => {
  const policyOf = (mode: 'block' | 'report', llm: Record<string, unknown>) => new PolicyEnforcer({ policy_id: 'p1', version: 1, mode, on_unavailable: 'fail_open', llm });

  it('refuses a denied model before the provider is called', async () => {
    const { events, capture } = recorder();
    const emitted: Array<[string, Record<string, unknown>]> = [];
    const option = { enforcer: policyOf('block', { denied_models: ['mx-*'] }), emit: (t: string, p: Record<string, unknown>) => { emitted.push([t, p]); } };
    const model = new FakeModel();
    expect(() => wrap(model, 'doGenerate', capture, option)({})).toThrow(AerPolicyError);
    expect(model.calls).toBe(0);
    expect(events).toHaveLength(0);
    expect(emitted).toEqual([['policy.violation', { policy_id: 'p1', version: 1, rule: 'model_denied', model: 'mx-model', action: 'block' }]]);
  });

  it('waits for a policy still being fetched, so the first call is governed', async () => {
    const { capture } = recorder();
    const model = new FakeModel();
    let enforcer = new PolicyEnforcer(null);
    let arrive!: () => void;
    const ready = new Promise<void>((r) => { arrive = r; });
    let pending = true;
    const source = () => ({ enforcer, emit: () => undefined, ...(pending ? { ready, waitUntil: Date.now() + 3_000 } : {}) });
    const call = wrap(model, 'doStream', capture, source)({});
    enforcer = policyOf('block', { denied_models: ['mx-model'] });
    pending = false;
    arrive();
    await expect(call).rejects.toBeInstanceOf(AerPolicyError);
    expect(model.calls).toBe(0);
  });

  it('never waits past the bound for a fetch that does not answer', async () => {
    const { capture } = recorder();
    const model = new FakeModel();
    const never = new Promise<void>(() => undefined);
    const source = () => ({ enforcer: new PolicyEnforcer(null), emit: () => undefined, ready: never, waitUntil: Date.now() + 80 });
    const started = Date.now();
    await wrap(model, 'doGenerate', capture, source)({});
    const took = Date.now() - started;
    expect(model.calls).toBe(1);
    expect(took).toBeGreaterThanOrEqual(70);
    expect(took).toBeLessThan(1_000);
  });

  it('does not wait at all when nothing is in flight', async () => {
    const { capture } = recorder();
    const model = new FakeModel();
    const option = { enforcer: policyOf('report', {}), emit: () => undefined };
    const started = Date.now();
    await wrap(model, 'doGenerate', capture, option)({});
    expect(Date.now() - started).toBeLessThan(50);
  });

  it('counts tokens after a streamed call', async () => {
    const { capture } = recorder();
    const emitted: string[] = [];
    const option = { enforcer: policyOf('report', { max_tokens_per_session: 5 }), emit: (t: string, p: Record<string, unknown>) => { emitted.push(`${t}:${String(p['rule'])}`); } };
    const model = new FakeModel();
    const result = await wrap(model, 'doStream', capture, option)({});
    expect(emitted).toEqual([]);
    await drain(result['stream'] as ReadableStream<unknown>);
    expect(emitted).toEqual(['policy.violation:token_budget']);
  });
});
