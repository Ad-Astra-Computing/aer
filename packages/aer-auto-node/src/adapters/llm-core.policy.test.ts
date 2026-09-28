import { describe, it, expect, vi } from 'vitest';
import { wrapCreate, type ProviderConfig } from './llm-core.js';
import type { CollectorEvent } from '../session.js';
import { PolicyEnforcer, AerPolicyError, type UsagePolicy } from '../policy.js';

const cfg: ProviderConfig = {
  provider: 'testllm',
  extractRequest: (args) => {
    const p = args[0] as { model?: string } | undefined;
    if (!p?.model) return null;
    return { provider: 'testllm', model: p.model };
  },
  extractResponse: (response) => {
    const r = response as { model?: string; usage?: { in?: number; out?: number } } | null;
    if (!r || typeof r !== 'object' || !('usage' in r)) return null;
    return {
      ...(r.model ? { model: r.model } : {}),
      ...(r.usage?.in != null ? { input_tokens: r.usage.in } : {}),
      ...(r.usage?.out != null ? { output_tokens: r.usage.out } : {}),
      tool_names: [],
    };
  },
};

function capt() {
  const events: CollectorEvent[] = [];
  return { capture: (e: CollectorEvent) => events.push(e), events };
}

function policy(over: Partial<UsagePolicy> = {}): UsagePolicy {
  return { policy_id: 'p1', version: 2, mode: 'block', on_unavailable: 'fail_open', ...over };
}

function policyOpt(events: CollectorEvent[], p: UsagePolicy | null) {
  const enforcer = new PolicyEnforcer(p);
  const emit = (event_type: string, payload: Record<string, unknown>): void => {
    events.push({ event_type, payload });
  };
  return { enforcer, emit };
}

describe('wrapCreate policy enforcement: block mode', () => {
  it('throws AerPolicyError BEFORE calling original for a denied model and emits policy.violation', async () => {
    const { capture, events } = capt();
    const original = vi.fn(async () => ({ model: 'gpt-4-vision', usage: { in: 1, out: 1 } }));
    const opt = policyOpt(events, policy({ mode: 'block', llm: { denied_models: ['*-vision'] } }));
    const wrapped = wrapCreate(original, cfg, capture, undefined, opt);

    expect(() => wrapped({ model: 'gpt-4-vision' })).toThrow(AerPolicyError);
    expect(original).not.toHaveBeenCalled();

    const violation = events.find((e) => e.event_type === 'policy.violation');
    expect(violation?.payload).toMatchObject({
      policy_id: 'p1', version: 2, rule: 'model_denied', model: 'gpt-4-vision', action: 'block',
    });
    // no llm.completed for a call that never happened
    expect(events.some((e) => e.event_type === 'llm.completed')).toBe(false);
  });

  it('the thrown error carries policy context', async () => {
    const { capture, events } = capt();
    const opt = policyOpt(events, policy({ mode: 'block', llm: { allowed_models: ['gpt-*'] } }));
    const wrapped = wrapCreate(async () => ({ usage: {} }), cfg, capture, undefined, opt);
    try {
      wrapped({ model: 'claude-opus-4' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AerPolicyError);
      expect((err as AerPolicyError).rule).toBe('model_not_allowed');
      expect((err as AerPolicyError).policyId).toBe('p1');
    }
  });
});

describe('wrapCreate policy enforcement: report mode', () => {
  it('emits policy.violation AND calls original and returns its result', async () => {
    const { capture, events } = capt();
    const response = { model: 'gpt-4-vision', usage: { in: 1, out: 1 } };
    const original = vi.fn(async () => response);
    const opt = policyOpt(events, policy({ mode: 'report', llm: { denied_models: ['*-vision'] } }));
    const wrapped = wrapCreate(original, cfg, capture, undefined, opt);

    const out = await wrapped({ model: 'gpt-4-vision' });
    await Promise.resolve();

    expect(out).toBe(response);
    expect(original).toHaveBeenCalledTimes(1);
    const violation = events.find((e) => e.event_type === 'policy.violation');
    expect(violation?.payload).toMatchObject({ rule: 'model_denied', action: 'report' });
    expect(events.some((e) => e.event_type === 'llm.completed')).toBe(true);
  });
});

describe('wrapCreate policy enforcement: budgets', () => {
  it('emits a call_budget violation in report mode when calls exceed the max', async () => {
    const { capture, events } = capt();
    const opt = policyOpt(events, policy({ mode: 'report', llm: { max_calls_per_session: 1 } }));
    const wrapped = wrapCreate(async () => ({ usage: {} }), cfg, capture, undefined, opt);
    await wrapped({ model: 'm' });
    await wrapped({ model: 'm' }); // exceeds
    const budget = events.filter((e) => e.event_type === 'policy.violation').map((e) => e.payload['rule']);
    expect(budget).toContain('call_budget');
  });

  it('emits a token_budget violation after the response is observed', async () => {
    const { capture, events } = capt();
    const opt = policyOpt(events, policy({ mode: 'block', llm: { max_tokens_per_session: 5 } }));
    const wrapped = wrapCreate(async () => ({ model: 'm', usage: { in: 4, out: 4 } }), cfg, capture, undefined, opt);
    await wrapped({ model: 'm' });
    await Promise.resolve();
    const budget = events.find((e) => e.event_type === 'policy.violation');
    // token budget is report-after even in block mode: never throws
    expect(budget?.payload).toMatchObject({ rule: 'token_budget', observed: 8, action: 'block' });
  });
});

describe('wrapCreate policy enforcement: inert paths', () => {
  it('no policy option => original called, no policy events', async () => {
    const { capture, events } = capt();
    const original = vi.fn(async () => ({ model: 'm', usage: { in: 1, out: 1 } }));
    const wrapped = wrapCreate(original, cfg, capture);
    await wrapped({ model: 'm' });
    await Promise.resolve();
    expect(original).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.event_type.startsWith('policy.'))).toBe(false);
  });

  it('disabled enforcer (null policy) => original called, no policy events', async () => {
    const { capture, events } = capt();
    const original = vi.fn(async () => ({ model: 'm', usage: { in: 1, out: 1 } }));
    const opt = policyOpt(events, null);
    const wrapped = wrapCreate(original, cfg, capture, undefined, opt);
    await wrapped({ model: 'm' });
    await Promise.resolve();
    expect(original).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.event_type === 'policy.violation')).toBe(false);
  });

  it('a bug in emit never breaks the SDK call (except the intentional block throw)', async () => {
    const { capture } = capt();
    const enforcer = new PolicyEnforcer(policy({ mode: 'report', llm: { denied_models: ['*'] } }));
    const emit = () => { throw new Error('emit boom'); };
    const original = vi.fn(async () => ({ model: 'm', usage: { in: 1, out: 1 } }));
    const wrapped = wrapCreate(original, cfg, capture, undefined, { enforcer, emit });
    await expect(wrapped({ model: 'm' })).resolves.toBeDefined();
    expect(original).toHaveBeenCalledTimes(1);
  });
});

// A client shaped like the OpenAI and Anthropic SDKs: the resource method
// returns the client's own promise, and the client awaits prepareOptions
// before it builds and sends the request.
function stainless(send: (body: unknown) => unknown) {
  const client = {
    sent: [] as unknown[],
    async prepareOptions(_o: unknown): Promise<void> { /* the SDK default */ },
    request(options: { body: unknown }): Promise<unknown> {
      return (async () => {
        await this.prepareOptions(options);
        client.sent.push(options.body);
        return send(options.body);
      })();
    },
  };
  // Like @anthropic-ai/sdk, which copies the params before sending them.
  const resource = { _client: client, create(body: unknown) { return client.request({ body: { ...(body as object) } }); } };
  return { client, resource };
}

describe('a call made while the first policy fetch is still in flight', () => {
  const stainlessCfg: ProviderConfig = { ...cfg, stainlessClient: true };

  function racing(events: CollectorEvent[]) {
    let enforcer = new PolicyEnforcer(null);
    let pending = true;
    let arrive!: () => void;
    const ready = new Promise<void>((r) => { arrive = r; });
    const source = () => ({
      enforcer,
      emit: (event_type: string, payload: Record<string, unknown>) => { events.push({ event_type, payload }); },
      ...(pending ? { ready, waitUntil: Date.now() + 3_000 } : {}),
    });
    const land = (p: UsagePolicy | null) => { enforcer = new PolicyEnforcer(p); pending = false; arrive(); };
    return { source, land };
  }

  it('is refused before the request is sent when the policy that lands denies it', async () => {
    const { capture, events } = capt();
    const { client, resource } = stainless(() => ({ usage: { in: 1, out: 1 } }));
    const r = racing(events);
    resource.create = wrapCreate(resource.create, stainlessCfg, capture, undefined, r.source) as typeof resource.create;
    const call = resource.create({ model: 'gpt-4-vision' });
    r.land(policy({ mode: 'block', llm: { denied_models: ['*-vision'] } }));
    await expect(call).rejects.toBeInstanceOf(AerPolicyError);
    expect(client.sent).toHaveLength(0);
    expect(events.map((e) => e.event_type)).toEqual(['policy.violation']);
  });

  it('goes ahead, recorded as usual, when the policy allows it', async () => {
    const { capture, events } = capt();
    const { client, resource } = stainless(() => ({ usage: { in: 2, out: 3 } }));
    const r = racing(events);
    resource.create = wrapCreate(resource.create, stainlessCfg, capture, undefined, r.source) as typeof resource.create;
    const call = resource.create({ model: 'gpt-4o' });
    r.land(policy({ mode: 'report' }));
    await expect(call).resolves.toBeDefined();
    await new Promise((res) => setTimeout(res, 0));
    expect(client.sent).toHaveLength(1);
    expect(events.map((e) => e.event_type)).toEqual(['llm.requested', 'llm.completed']);
  });

  it('keeps the SDK own promise object', () => {
    const { capture, events } = capt();
    const { resource } = stainless(() => ({ usage: {} }));
    const r = racing(events);
    const orig = resource.create;
    let returned: unknown;
    resource.create = ((body: unknown) => { returned = orig.call(resource, body); return returned; }) as typeof resource.create;
    resource.create = wrapCreate(resource.create, stainlessCfg, capture, undefined, r.source) as typeof resource.create;
    const out = resource.create({ model: 'gpt-4o' });
    expect(out).toBe(returned);
    r.land(null);
  });

  it('is sent without waiting past the bound when the fetch never answers', async () => {
    const { capture, events } = capt();
    const { client, resource } = stainless(() => ({ usage: {} }));
    const source = () => ({ enforcer: new PolicyEnforcer(null), emit: () => undefined, ready: new Promise<void>(() => undefined), waitUntil: Date.now() + 80 });
    resource.create = wrapCreate(resource.create, stainlessCfg, capture, undefined, source) as typeof resource.create;
    const started = Date.now();
    await resource.create({ model: 'gpt-4o' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(client.sent).toHaveLength(1);
    void events;
  });

  it('falls back to an ungated call when the client has no prepareOptions', async () => {
    const { capture, events } = capt();
    const original = vi.fn(async () => ({ usage: {} }));
    const r = racing(events);
    const wrapped = wrapCreate(original, stainlessCfg, capture, undefined, r.source);
    await wrapped({ model: 'gpt-4-vision' });
    expect(original).toHaveBeenCalledTimes(1);
    r.land(null);
  });
});
