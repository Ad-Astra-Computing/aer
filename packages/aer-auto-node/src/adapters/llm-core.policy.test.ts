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

describe('wrapCreate policy enforcement — block mode', () => {
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

describe('wrapCreate policy enforcement — report mode', () => {
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

describe('wrapCreate policy enforcement — budgets', () => {
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

describe('wrapCreate policy enforcement — inert paths', () => {
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
