import { describe, it, expect } from 'vitest';
import { BaselineModel, Baseline, Finding } from './baseline.js';
import { newUuidV7 } from './id.js';

describe('BaselineModel (rules.v1)', () => {
  it('accepts an empty model', () => {
    expect(
      BaselineModel.safeParse({
        model_version: 'rules.v1',
        allowed_domains: [],
        allowed_tools: [],
        allowed_tool_sequences: [],
        trained_from_session_ids: [],
      }).success,
    ).toBe(true);
  });

  it('accepts a populated model', () => {
    expect(
      BaselineModel.safeParse({
        model_version: 'rules.v1',
        allowed_domains: ['a.com', 'b.com'],
        allowed_tools: ['search', 'fetch'],
        allowed_tool_sequences: [['search', 'fetch']],
        trained_from_session_ids: [newUuidV7(), newUuidV7()],
      }).success,
    ).toBe(true);
  });

  it('rejects wrong model_version', () => {
    expect(
      BaselineModel.safeParse({
        model_version: 'rules.v99',
        allowed_domains: [],
        allowed_tools: [],
        allowed_tool_sequences: [],
        trained_from_session_ids: [],
      }).success,
    ).toBe(false);
  });

  it('rejects unknown top-level keys', () => {
    expect(
      BaselineModel.safeParse({
        model_version: 'rules.v1',
        allowed_domains: [],
        allowed_tools: [],
        allowed_tool_sequences: [],
        trained_from_session_ids: [],
        surprise: 1,
      }).success,
    ).toBe(false);
  });
});

describe('Baseline', () => {
  it('accepts a valid baseline', () => {
    expect(
      Baseline.safeParse({
        baseline_id: newUuidV7(),
        tenant_id: newUuidV7(),
        agent_id: newUuidV7(),
        scope: 'agent_version',
        trained_from_session_count: 3,
        valid_from: '2026-04-20T14:11:00.000Z',
        model_version: 'rules.v1',
        model: {
          model_version: 'rules.v1',
          allowed_domains: [],
          allowed_tools: [],
          allowed_tool_sequences: [],
          trained_from_session_ids: [],
        },
      }).success,
    ).toBe(true);
  });

  it('rejects negative trained_from_session_count', () => {
    expect(
      Baseline.safeParse({
        baseline_id: newUuidV7(),
        tenant_id: newUuidV7(),
        agent_id: newUuidV7(),
        scope: 'agent_version',
        trained_from_session_count: -1,
        valid_from: '2026-04-20T14:11:00.000Z',
        model_version: 'rules.v1',
        model: {
          model_version: 'rules.v1',
          allowed_domains: [],
          allowed_tools: [],
          allowed_tool_sequences: [],
          trained_from_session_ids: [],
        },
      }).success,
    ).toBe(false);
  });

  it('rejects valid_to before valid_from', () => {
    expect(
      Baseline.safeParse({
        baseline_id: newUuidV7(),
        tenant_id: newUuidV7(),
        agent_id: newUuidV7(),
        scope: 'agent_version',
        trained_from_session_count: 0,
        valid_from: '2026-04-20T14:11:00.000Z',
        valid_to: '2026-04-19T14:11:00.000Z',
        model_version: 'rules.v1',
        model: {
          model_version: 'rules.v1',
          allowed_domains: [],
          allowed_tools: [],
          allowed_tool_sequences: [],
          trained_from_session_ids: [],
        },
      }).success,
    ).toBe(false);
  });
});

describe('Finding', () => {
  const base = {
    finding_id: newUuidV7(),
    agent_session_id: newUuidV7(),
    tenant_id: newUuidV7(),
    class: 'deviation' as const,
    subtype: 'new_domain',
    severity: 'low' as const,
    confidence: 0.9,
    summary: 'Unseen domain contacted: payments.example',
    evidence_refs: [{ type: 'event', ref: newUuidV7() }],
  };

  it('accepts a valid finding', () => {
    expect(Finding.safeParse(base).success).toBe(true);
  });

  it('rejects unknown class', () => {
    expect(Finding.safeParse({ ...base, class: 'bogus' }).success).toBe(false);
  });

  it('rejects confidence outside [0,1]', () => {
    expect(Finding.safeParse({ ...base, confidence: 1.2 }).success).toBe(false);
  });

  it('rejects unknown evidence_ref type', () => {
    expect(
      Finding.safeParse({ ...base, evidence_refs: [{ type: 'weird', ref: newUuidV7() }] }).success,
    ).toBe(false);
  });

  it('requires summary string of at least 1 char', () => {
    expect(Finding.safeParse({ ...base, summary: '' }).success).toBe(false);
  });
});

describe('BaselineModel — finite bounds (amplification defense)', () => {
  const model = {
    model_version: 'rules.v1' as const,
    allowed_domains: [] as string[],
    allowed_tools: [] as string[],
    allowed_tool_sequences: [] as string[][],
    trained_from_session_ids: [] as string[],
  };

  it('accepts a normal trained baseline', () => {
    expect(
      BaselineModel.safeParse({ ...model, allowed_domains: ['a.com'], allowed_tools: ['search'] }).success,
    ).toBe(true);
  });

  it('rejects an absurdly long allowed_domains entry', () => {
    expect(
      BaselineModel.safeParse({ ...model, allowed_domains: ['a'.repeat(65_537)] }).success,
    ).toBe(false);
  });
});
