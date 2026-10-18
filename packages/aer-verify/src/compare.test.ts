import { describe, it, expect } from 'vitest';
import { HOSTILE_OBJECTS, answersRatherThanCrashes } from '@aer-oss/attestation-test-utils';
import { compareBundles } from './compare.js';

const TAG_A1 = 'a'.repeat(64);
const TAG_A2 = 'b'.repeat(64);
const TAG_B1 = 'c'.repeat(64);
const RESP_1 = 'd'.repeat(64);
const RESP_2 = 'e'.repeat(64);
const WIRE_1 = 'f'.repeat(64);
const KID_1 = '1'.repeat(16);
const KID_2 = '2'.repeat(16);

function commitment(overrides: Record<string, unknown> = {}) {
  return {
    request_ref: 'r1',
    provider: 'openai',
    model: 'gpt-4o',
    kid: KID_1,
    canon: 'aer-canon.v1',
    capture_point: 'adapter_request',
    prompt_canon_tag: TAG_A1,
    outcome: 'ok',
    message_count: 1,
    prompt_bytes: 10,
    retained: 'none',
    at: '2026-10-18T00:00:00.000Z',
    ...overrides,
  };
}

function bundle(overrides: Record<string, unknown> = {}) {
  return {
    aer_id: 'aer-1',
    content_commitments: [commitment()],
    execution_graph: { nodes: [{ type: 'llm.requested' }, { type: 'llm.completed' }], edges: [] },
    observations: { domains_contacted: [], tools_used: ['bash'], files_touched: [], processes_spawned: [] },
    llm_activity: { providers: [{ provider: 'openai', calls: 1, completed: 1, errors: 0, streaming: 0, input_tokens: 0, output_tokens: 0, tokens_observed: false, models: ['gpt-4o'], tool_selections: 0 }], totals: {} },
    ...overrides,
  };
}

describe('compareBundles - no plaintext discipline', () => {
  it('never returns a string longer than a hex64 tag anywhere in the result', () => {
    const SECRET = 'SECRETprompt this must never appear';
    const a = bundle();
    const b = bundle({ content_commitments: [commitment({ prompt_canon_tag: TAG_B1 })] });
    const res = compareBundles(a, b);
    const json = JSON.stringify(res);
    expect(json).not.toContain(SECRET);
    // No field is ever longer than an opaque hex64 tag plus quoting/brackets.
    for (const v of Object.values(res)) {
      if (typeof v === 'string') expect(v.length).toBeLessThanOrEqual(64);
    }
  });
});

describe('compareBundles - identical runs', () => {
  it('reports identical on every dimension for two equal bundles', () => {
    const res = compareBundles(bundle(), bundle());
    expect(res.comparable).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(res.kid).toBe(KID_1);
    expect(res.prompts).toEqual({ count_a: 1, count_b: 1, aligned: true, identical: true, first_divergence: null });
    expect(res.actions.identical).toBe(true);
    expect(res.actions.a_only).toEqual([]);
    expect(res.actions.b_only).toEqual([]);
    expect(res.models.identical).toBe(true);
  });
});

describe('compareBundles - prompt divergence', () => {
  it('locates the first index where a prompt tag differs', () => {
    const a = bundle({ content_commitments: [commitment({ prompt_canon_tag: TAG_A1 }), commitment({ prompt_canon_tag: TAG_A2 })] });
    const b = bundle({ content_commitments: [commitment({ prompt_canon_tag: TAG_A1 }), commitment({ prompt_canon_tag: TAG_B1 })] });
    const res = compareBundles(a, b);
    expect(res.comparable).toBe(true);
    expect(res.prompts.identical).toBe(false);
    expect(res.prompts.first_divergence).toBe(1);
    expect(res.prompts.aligned).toBe(true);
  });

  it('reports length mismatch as not aligned, not identical', () => {
    const a = bundle({ content_commitments: [commitment(), commitment()] });
    const b = bundle({ content_commitments: [commitment()] });
    const res = compareBundles(a, b);
    expect(res.prompts.aligned).toBe(false);
    expect(res.prompts.identical).toBe(false);
    expect(res.prompts.count_a).toBe(2);
    expect(res.prompts.count_b).toBe(1);
  });
});

describe('compareBundles - response and wire tags', () => {
  it('compares response_tag and wire.tag independently of prompt tags', () => {
    const a = bundle({ content_commitments: [commitment({ response_tag: RESP_1, wire: { canon: 'aer-wire.v1', tag: WIRE_1 } })] });
    const b = bundle({ content_commitments: [commitment({ response_tag: RESP_2, wire: { canon: 'aer-wire.v1', tag: WIRE_1 } })] });
    const res = compareBundles(a, b);
    expect(res.prompts.identical).toBe(true);
    expect(res.responses.identical).toBe(false);
    expect(res.responses.first_divergence).toBe(0);
    expect(res.wire.identical).toBe(true);
  });
});

describe('compareBundles - tool_arg_tags', () => {
  it('compares tool arg tag bags order-independently', () => {
    const a = bundle({ content_commitments: [commitment({ tool_arg_tags: [{ tool: 'bash', tag: TAG_A1 }, { tool: 'read', tag: TAG_A2 }] })] });
    const b = bundle({ content_commitments: [commitment({ tool_arg_tags: [{ tool: 'read', tag: TAG_A2 }, { tool: 'bash', tag: TAG_A1 }] })] });
    const res = compareBundles(a, b);
    expect(res.tool_args.identical).toBe(true);
  });

  it('detects a differing tool arg tag', () => {
    const a = bundle({ content_commitments: [commitment({ tool_arg_tags: [{ tool: 'bash', tag: TAG_A1 }] })] });
    const b = bundle({ content_commitments: [commitment({ tool_arg_tags: [{ tool: 'bash', tag: TAG_B1 }] })] });
    const res = compareBundles(a, b);
    expect(res.tool_args.identical).toBe(false);
    expect(res.tool_args.first_divergence).toBe(0);
  });
});

describe('compareBundles - actions and models', () => {
  it('reports the first action-sequence divergence and tool set differences', () => {
    const a = bundle({ execution_graph: { nodes: [{ type: 'llm.requested' }, { type: 'tool.selected' }], edges: [] }, observations: { domains_contacted: [], tools_used: ['bash'], files_touched: [], processes_spawned: [] } });
    const b = bundle({ execution_graph: { nodes: [{ type: 'llm.requested' }, { type: 'llm.completed' }], edges: [] }, observations: { domains_contacted: [], tools_used: ['curl'], files_touched: [], processes_spawned: [] } });
    const res = compareBundles(a, b);
    expect(res.actions.identical).toBe(false);
    expect(res.actions.first_divergence).toBe(1);
    expect(res.actions.a_only).toEqual(['bash']);
    expect(res.actions.b_only).toEqual(['curl']);
  });

  it('flags a model mismatch independently of the commitment comparison', () => {
    const a = bundle();
    const b = bundle({ llm_activity: { providers: [{ provider: 'openai', calls: 1, completed: 1, errors: 0, streaming: 0, input_tokens: 0, output_tokens: 0, tokens_observed: false, models: ['gpt-4o-mini'], tool_selections: 0 }], totals: {} } });
    const res = compareBundles(a, b);
    expect(res.models.identical).toBe(false);
  });
});

describe('compareBundles - kid mismatch and missing commitments', () => {
  it('reports kid_mismatch and refuses to claim identical/different on tag dimensions', () => {
    const a = bundle({ content_commitments: [commitment({ kid: KID_1 })] });
    const b = bundle({ content_commitments: [commitment({ kid: KID_2 })] });
    const res = compareBundles(a, b);
    expect(res.comparable).toBe(false);
    expect(res.reason).toBe('kid_mismatch');
    expect(res.kid).toBeNull();
    expect(res.prompts.identical).toBe(false);
  });

  it('reports no_commitments_b when one side has no commitments at all', () => {
    const a = bundle();
    const b = bundle({ content_commitments: [] });
    const res = compareBundles(a, b);
    expect(res.comparable).toBe(false);
    expect(res.reason).toBe('no_commitments_b');
  });

  it('still populates actions and models when not comparable on commitments', () => {
    const a = bundle({ content_commitments: [] });
    const b = bundle({ content_commitments: [] });
    const res = compareBundles(a, b);
    expect(res.comparable).toBe(false);
    expect(res.actions.identical).toBe(true);
    expect(res.models.identical).toBe(true);
  });
});

describe('compareBundles - truncation never claims identical', () => {
  it('refuses identical on a truncated dimension even when the observed tags match', () => {
    const a = bundle({ content_commitments_truncated: true as const });
    const b = bundle();
    const res = compareBundles(a, b);
    expect(res.comparable).toBe(true);
    expect(res.reason).toBe('truncated');
    expect(res.prompts.identical).toBe(false);
    expect(res.responses.identical).toBe(false);
  });
});

describe('compareBundles answers rather than throws on hostile input', () => {
  it.each(HOSTILE_OBJECTS.map(([label, value]) => [label, value] as const))(
    'returns a verdict for %s as bundle a',
    async (_label, value) => {
      const res = await answersRatherThanCrashes(() => compareBundles(value, bundle()));
      expect(res).toEqual({ ok: true });
    },
  );

  it.each(HOSTILE_OBJECTS.map(([label, value]) => [label, value] as const))(
    'returns a verdict for %s as bundle b',
    async (_label, value) => {
      const res = await answersRatherThanCrashes(() => compareBundles(bundle(), value));
      expect(res).toEqual({ ok: true });
    },
  );

  it('does not pollute Object.prototype', () => {
    compareBundles(JSON.parse('{"__proto__":{"polluted":true}}'), bundle());
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
