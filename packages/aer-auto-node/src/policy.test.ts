import { describe, it, expect } from 'vitest';
import {
  matchModel,
  PolicyEnforcer,
  AerPolicyError,
  type UsagePolicy,
} from './policy.js';

describe('matchModel', () => {
  it('matches exact model names', () => {
    expect(matchModel(['gpt-4o'], 'gpt-4o')).toBe(true);
    expect(matchModel(['gpt-4o'], 'gpt-4o-mini')).toBe(false);
  });

  it('matches with a trailing * wildcard', () => {
    expect(matchModel(['gpt-*'], 'gpt-4o')).toBe(true);
    expect(matchModel(['gpt-*'], 'gpt-4o-mini')).toBe(true);
    expect(matchModel(['claude-*'], 'claude-opus-4')).toBe(true);
    expect(matchModel(['gpt-*'], 'claude-opus-4')).toBe(false);
  });

  it('matches with a leading and internal * wildcard', () => {
    expect(matchModel(['*-vision'], 'gpt-4-vision')).toBe(true);
    expect(matchModel(['*-vision'], 'gpt-4o')).toBe(false);
    expect(matchModel(['gpt-*-preview'], 'gpt-4o-preview')).toBe(true);
    expect(matchModel(['gpt-*-preview'], 'gpt-4o')).toBe(false);
  });

  it('is case sensitive', () => {
    expect(matchModel(['gpt-*'], 'GPT-4o')).toBe(false);
  });

  it('a bare * matches anything', () => {
    expect(matchModel(['*'], 'anything-at-all')).toBe(true);
    expect(matchModel(['*'], '')).toBe(true);
  });

  it('empty patterns never match', () => {
    expect(matchModel([], 'gpt-4o')).toBe(false);
  });

  it('does not let regex metacharacters in the model leak into the match', () => {
    // A '.' in a pattern is a literal dot, not "any char".
    expect(matchModel(['a.b'], 'axb')).toBe(false);
    expect(matchModel(['a.b'], 'a.b')).toBe(true);
  });
});

function enforcer(policy: UsagePolicy | null): PolicyEnforcer {
  return new PolicyEnforcer(policy);
}

function policy(over: Partial<UsagePolicy> = {}): UsagePolicy {
  return {
    policy_id: 'p1',
    version: 3,
    mode: 'block',
    on_unavailable: 'fail_open',
    ...over,
  };
}

describe('PolicyEnforcer.beforeCall: model rules', () => {
  it('block mode: denied model returns a blocking violation', () => {
    const e = enforcer(policy({ mode: 'block', llm: { denied_models: ['*-vision'] } }));
    const { violations, block } = e.beforeCall('gpt-4-vision');
    expect(block).not.toBeNull();
    expect(block).toMatchObject({ rule: 'model_denied', model: 'gpt-4-vision', action: 'block' });
    expect(violations).toHaveLength(1);
  });

  it('report mode: denied model reports but does not block', () => {
    const e = enforcer(policy({ mode: 'report', llm: { denied_models: ['*-vision'] } }));
    const { violations, block } = e.beforeCall('gpt-4-vision');
    expect(block).toBeNull();
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ rule: 'model_denied', action: 'report' });
  });

  it('allowed_models allowlist: a model not in the list is model_not_allowed', () => {
    const e = enforcer(policy({ mode: 'block', llm: { allowed_models: ['gpt-*'] } }));
    const denied = e.beforeCall('claude-opus-4');
    expect(denied.block).toMatchObject({ rule: 'model_not_allowed', model: 'claude-opus-4' });
    const ok = enforcer(policy({ mode: 'block', llm: { allowed_models: ['gpt-*'] } })).beforeCall('gpt-4o');
    expect(ok.block).toBeNull();
    expect(ok.violations).toHaveLength(0);
  });

  it('denied takes precedence over allowed', () => {
    const e = enforcer(policy({ mode: 'block', llm: { allowed_models: ['gpt-*'], denied_models: ['gpt-4-vision'] } }));
    const { block } = e.beforeCall('gpt-4-vision');
    expect(block).toMatchObject({ rule: 'model_denied' });
  });

  it('undefined model with an allowlist is model_not_allowed', () => {
    const e = enforcer(policy({ mode: 'block', llm: { allowed_models: ['gpt-*'] } }));
    const { block } = e.beforeCall(undefined);
    expect(block).toMatchObject({ rule: 'model_not_allowed' });
  });

  it('no llm rules: any model passes', () => {
    const e = enforcer(policy({ mode: 'block' }));
    expect(e.beforeCall('anything').block).toBeNull();
  });
});

describe('PolicyEnforcer.beforeCall: call budget', () => {
  it('emits call_budget when the call count EXCEEDS the max', () => {
    const e = enforcer(policy({ mode: 'block', llm: { max_calls_per_session: 2 } }));
    expect(e.beforeCall('m').block).toBeNull(); // call 1
    expect(e.beforeCall('m').block).toBeNull(); // call 2
    const third = e.beforeCall('m'); // call 3 exceeds
    expect(third.block).toMatchObject({ rule: 'call_budget', limit: 2, observed: 3 });
  });

  it('report mode call budget reports and passes', () => {
    const e = enforcer(policy({ mode: 'report', llm: { max_calls_per_session: 1 } }));
    expect(e.beforeCall('m').violations).toHaveLength(0);
    const second = e.beforeCall('m');
    expect(second.block).toBeNull();
    expect(second.violations[0]).toMatchObject({ rule: 'call_budget', action: 'report', limit: 1, observed: 2 });
  });
});

describe('PolicyEnforcer.afterCall: token budget', () => {
  it('emits token_budget when cumulative tokens EXCEED the max (report action in block mode, never throws)', () => {
    const e = enforcer(policy({ mode: 'block', llm: { max_tokens_per_session: 100 } }));
    expect(e.afterCall(40, 40)).toHaveLength(0); // 80 total, under
    const v = e.afterCall(30, 0); // 110 total, over
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ rule: 'token_budget', limit: 100, observed: 110, action: 'block' });
  });

  it('report mode token budget uses report action', () => {
    const e = enforcer(policy({ mode: 'report', llm: { max_tokens_per_session: 10 } }));
    const v = e.afterCall(6, 6);
    expect(v[0]).toMatchObject({ rule: 'token_budget', action: 'report', observed: 12 });
  });

  it('afterCall never throws', () => {
    const e = enforcer(policy({ mode: 'block', llm: { max_tokens_per_session: 1 } }));
    expect(() => e.afterCall(100, 100)).not.toThrow();
  });

  it('treats missing token counts as zero', () => {
    const e = enforcer(policy({ mode: 'block', llm: { max_tokens_per_session: 5 } }));
    expect(e.afterCall(undefined, undefined)).toHaveLength(0);
    expect(e.afterCall(6)).toHaveLength(1);
  });
});

describe('PolicyEnforcer: disabled paths', () => {
  it('mode off is a no-op', () => {
    const e = enforcer(policy({ mode: 'off', llm: { denied_models: ['*'], max_calls_per_session: 0, max_tokens_per_session: 0 } }));
    expect(e.beforeCall('anything')).toEqual({ violations: [], block: null });
    expect(e.afterCall(1000, 1000)).toEqual([]);
    expect(e.active).toBe(false);
  });

  it('null policy is a no-op', () => {
    const e = enforcer(null);
    expect(e.beforeCall('anything')).toEqual({ violations: [], block: null });
    expect(e.afterCall(1000, 1000)).toEqual([]);
    expect(e.active).toBe(false);
  });

  it('active is true for report and block modes', () => {
    expect(enforcer(policy({ mode: 'report' })).active).toBe(true);
    expect(enforcer(policy({ mode: 'block' })).active).toBe(true);
  });

  it('exposes policy_id and version for event payloads', () => {
    const e = enforcer(policy({ policy_id: 'abc', version: 9 }));
    expect(e.policyId).toBe('abc');
    expect(e.version).toBe(9);
  });
});

describe('AerPolicyError', () => {
  it('carries the rule + context fields', () => {
    const err = new AerPolicyError({ rule: 'model_denied', model: 'x', policyId: 'p', version: 1 });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AerPolicyError');
    expect(err.rule).toBe('model_denied');
    expect(err.model).toBe('x');
    expect(err.policyId).toBe('p');
    expect(err.version).toBe(1);
  });
});
