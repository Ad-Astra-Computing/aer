import { describe, it, expect } from 'vitest';
import { UsagePolicyInput, PolicyVerdict } from './policy.js';

describe('UsagePolicyInput', () => {
  it('applies defaults for mode and on_unavailable', () => {
    const p = UsagePolicyInput.parse({ llm: { max_calls_per_session: 200 } });
    expect(p.mode).toBe('report');
    expect(p.on_unavailable).toBe('fail_open');
  });

  it('accepts a full policy', () => {
    const p = UsagePolicyInput.parse({
      scope: { environment_id: '01950000-0000-7000-8000-000000000009' },
      llm: { allowed_models: ['gpt-*'], denied_models: ['*-vision'], max_tokens_per_session: 1000, max_calls_per_session: 10 },
      mode: 'block',
      on_unavailable: 'fail_closed',
    });
    expect(p.mode).toBe('block');
  });

  it('rejects an unknown mode', () => {
    expect(UsagePolicyInput.safeParse({ mode: 'nope' }).success).toBe(false);
  });

  it('rejects a negative token budget and an over-long model list', () => {
    expect(UsagePolicyInput.safeParse({ llm: { max_tokens_per_session: -1 } }).success).toBe(false);
    expect(UsagePolicyInput.safeParse({ llm: { allowed_models: Array(101).fill('x') } }).success).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(UsagePolicyInput.safeParse({ mode: 'off', extra: 1 }).success).toBe(false);
  });
});

describe('PolicyVerdict', () => {
  it('validates the compact bundle verdict', () => {
    const v = PolicyVerdict.parse({ policy_id: '01950000-0000-7000-8000-00000000000a', version: 3, mode: 'block', violations: 0 });
    expect(v.violations).toBe(0);
  });
});
