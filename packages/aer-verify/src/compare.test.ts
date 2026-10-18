import { describe, it, expect } from 'vitest';
import { HOSTILE_OBJECTS, answersRatherThanCrashes } from '@aer-oss/attestation-test-utils';
import { compareBundles } from './compare.js';

const TAG_A1 = 'a'.repeat(64);
const TAG_A2 = 'b'.repeat(64);
const TAG_B1 = 'c'.repeat(64);
const RESP_1 = 'd'.repeat(64);
const RESP_2 = 'e'.repeat(64);
const WIRE_1 = 'f'.repeat(64);
const TOOL_TAG_1 = '3'.repeat(64);
const KID_1 = '1'.repeat(16);
const KID_2 = '2'.repeat(16);

// A commitment with every optional tag populated, so "identical runs" exercises
// applicability on prompts, responses, wire and tool_args, not just prompts.
function commitment(overrides: Record<string, unknown> = {}) {
  return {
    request_ref: 'r1',
    provider: 'openai',
    model: 'gpt-4o',
    kid: KID_1,
    canon: 'aer-canon.v1',
    capture_point: 'adapter_request',
    prompt_canon_tag: TAG_A1,
    response_tag: RESP_1,
    wire: { canon: 'aer-wire.v1', tag: WIRE_1 },
    tool_arg_tags: [{ tool: 'bash', tag: TOOL_TAG_1 }],
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
  it('never leaks a secret planted in a non-allowlisted bundle field', () => {
    const SECRET = 'SECRET-prompt-text-must-never-appear-anywhere';
    const a = bundle({
      aer_id: SECRET, // not in the allowlisted output set; echoed back verbatim if leaked
      content_commitments: [commitment({ request_ref: SECRET, prompt: SECRET, prompt_canon_tag: TAG_A1 })],
      observations: { domains_contacted: [], tools_used: ['bash'], files_touched: [], processes_spawned: [] },
      execution_graph: { nodes: [{ type: 'llm.requested', label: SECRET }], edges: [] },
    });
    const b = bundle({ content_commitments: [commitment({ prompt_canon_tag: TAG_B1 })] });
    const res = compareBundles(a, b);
    expect(JSON.stringify(res)).not.toContain(SECRET);
  });

  it('every tag field in the result is either an opaque 16/64-char hex value or null, even with a long string planted on a divergent position', () => {
    // Exercise an actual divergence (unlike the identical-bundles case,
    // which never visits a position where a secret-shaped tag would differ)
    // so this proves the bound holds exactly where a leak would show up.
    // actions.a_only/b_only are excluded deliberately: that one field echoes
    // free-text tools_used verbatim, by design (see the next test) and is
    // not part of this claim.
    const LONG_SECRET = 'y'.repeat(200);
    const a = bundle({ content_commitments: [commitment({ prompt_canon_tag: TAG_A1, request_ref: LONG_SECRET })] });
    const b = bundle({ content_commitments: [commitment({ prompt_canon_tag: TAG_B1 })] });
    const res = compareBundles(a, b);
    const { a_only, b_only, ...rest } = res.actions;
    const walk = (v: unknown): void => {
      if (typeof v === 'string') expect(v.length).toBeLessThanOrEqual(64);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (typeof v === 'object' && v !== null) Object.values(v).forEach(walk);
    };
    walk({ ...res, actions: rest });
    expect(JSON.stringify(res)).not.toContain(LONG_SECRET);
  });

  it('a_only/b_only echo free-text tools_used strings verbatim - documents the one echo path, with no length bound applied', () => {
    // observations.tools_used is free-text in the signed bundle (names, per
    // AGENTS.md), so compareBundles DOES echo it back through a_only/b_only,
    // and does NOT bound its length the way an opaque tag is bounded. This
    // is a known, bundle-already-signed-it exception to "opaque tags only",
    // recorded here so a future change cannot widen it unnoticed.
    const LONG_TOOL_NAME = 'x'.repeat(100);
    const a = bundle({ observations: { domains_contacted: [], tools_used: [LONG_TOOL_NAME], files_touched: [], processes_spawned: [] } });
    const b = bundle({ observations: { domains_contacted: [], tools_used: [], files_touched: [], processes_spawned: [] } });
    const res = compareBundles(a, b);
    expect(res.actions.a_only).toEqual([LONG_TOOL_NAME]);
    expect(LONG_TOOL_NAME.length).toBeGreaterThan(64);
  });
});

describe('compareBundles - identical runs', () => {
  it('reports identical and applicable on every tag dimension for two equal, fully-populated bundles', () => {
    const res = compareBundles(bundle(), bundle());
    expect(res.comparable).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(res.kid).toBe(KID_1);
    for (const dim of [res.prompts, res.responses, res.tool_args, res.wire]) {
      expect(dim.applicable).toBe(true);
      expect(dim.identical).toBe(true);
      expect(dim.first_divergence).toBeNull();
    }
    expect(res.actions.identical).toBe(true);
    expect(res.actions.a_only).toEqual([]);
    expect(res.actions.b_only).toEqual([]);
    expect(res.models.identical).toBe(true);
  });
});

describe('compareBundles - absent evidence is never claimed identical', () => {
  it('both sides never emitted response_tag/wire/tool_arg_tags: not applicable, not identical', () => {
    const minimal = () => bundle({ content_commitments: [commitment({ response_tag: undefined, wire: undefined, tool_arg_tags: undefined })] });
    const res = compareBundles(minimal(), minimal());
    expect(res.responses).toEqual({ count_a: 1, count_b: 1, aligned: true, compared: 1, applicable: false, identical: false, first_divergence: null });
    expect(res.wire).toEqual({ count_a: 1, count_b: 1, aligned: true, compared: 1, applicable: false, identical: false, first_divergence: null });
    expect(res.tool_args).toEqual({ count_a: 1, count_b: 1, aligned: true, compared: 1, applicable: false, identical: false, first_divergence: null });
    // prompts IS populated on both sides, so it stays applicable and identical.
    expect(res.prompts.applicable).toBe(true);
    expect(res.prompts.identical).toBe(true);
  });

  it('both sides carry only a malformed tag: not applicable, not a false match', () => {
    const a = bundle({ content_commitments: [commitment({ prompt_canon_tag: 'not-hex64' })] });
    const b = bundle({ content_commitments: [commitment({ prompt_canon_tag: 'also-not-hex64' })] });
    const res = compareBundles(a, b);
    expect(res.prompts.applicable).toBe(false);
    expect(res.prompts.identical).toBe(false);
  });

  it('one side present, one side absent: real divergence, not a wash', () => {
    const a = bundle({ content_commitments: [commitment({ response_tag: RESP_1 })] });
    const b = bundle({ content_commitments: [commitment({ response_tag: undefined })] });
    const res = compareBundles(a, b);
    // applicable MUST be true here: one side having a tag and the other not
    // is evidence of a real difference, not "nothing to compare". If
    // applicable were false, the CLI's "non-applicable dimensions don't
    // block exit 0" rule would silently pass this divergence.
    expect(res.responses.applicable).toBe(true);
    expect(res.responses.identical).toBe(false);
    expect(res.responses.first_divergence).toBe(0);
  });

  it('an explicit empty tool_arg_tags array on both sides IS evidence of "no tool calls", and counts as identical', () => {
    const a = bundle({ content_commitments: [commitment({ tool_arg_tags: [] })] });
    const b = bundle({ content_commitments: [commitment({ tool_arg_tags: [] })] });
    const res = compareBundles(a, b);
    expect(res.tool_args.applicable).toBe(true);
    expect(res.tool_args.identical).toBe(true);
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
    const TOOL_TAG_2 = '4'.repeat(64);
    const a = bundle({ content_commitments: [commitment({ tool_arg_tags: [{ tool: 'bash', tag: TOOL_TAG_1 }, { tool: 'read', tag: TOOL_TAG_2 }] })] });
    const b = bundle({ content_commitments: [commitment({ tool_arg_tags: [{ tool: 'read', tag: TOOL_TAG_2 }, { tool: 'bash', tag: TOOL_TAG_1 }] })] });
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

  it('never reports identical when either side flagged tool_args_truncated, even though the kept entries match (regression: a capped bag must not hide its dropped tail)', () => {
    const a = bundle({ content_commitments: [commitment({ tool_arg_tags: [{ tool: 'bash', tag: TOOL_TAG_1 }], tool_args_truncated: true })] });
    const b = bundle({ content_commitments: [commitment({ tool_arg_tags: [{ tool: 'bash', tag: TOOL_TAG_1 }] })] });
    const res = compareBundles(a, b);
    expect(res.tool_args.identical).toBe(false);
    expect(res.tool_args.first_divergence).toBe(0);
  });
});

describe('compareBundles - tool_result_tags', () => {
  const RESULT_TAG_1 = '5'.repeat(64);
  const RESULT_TAG_2 = '6'.repeat(64);

  it('compares tool result tag bags order-independently', () => {
    const a = bundle({ content_commitments: [commitment({ tool_result_tags: [RESULT_TAG_1, RESULT_TAG_2] })] });
    const b = bundle({ content_commitments: [commitment({ tool_result_tags: [RESULT_TAG_2, RESULT_TAG_1] })] });
    const res = compareBundles(a, b);
    expect(res.tool_results.identical).toBe(true);
  });

  it('detects a differing tool result tag - tool output fed back into the next request is an input too', () => {
    const a = bundle({ content_commitments: [commitment({ tool_result_tags: [RESULT_TAG_1] })] });
    const b = bundle({ content_commitments: [commitment({ tool_result_tags: [RESULT_TAG_2] })] });
    const res = compareBundles(a, b);
    expect(res.tool_results.identical).toBe(false);
    expect(res.tool_results.first_divergence).toBe(0);
  });

  it('never reports identical when either side flagged tool_results_truncated', () => {
    const a = bundle({ content_commitments: [commitment({ tool_result_tags: [RESULT_TAG_1], tool_results_truncated: true })] });
    const b = bundle({ content_commitments: [commitment({ tool_result_tags: [RESULT_TAG_1] })] });
    const res = compareBundles(a, b);
    expect(res.tool_results.identical).toBe(false);
  });

  it('not applicable when neither side ever emitted tool_result_tags', () => {
    const res = compareBundles(bundle(), bundle());
    // the shared bundle() fixture has no tool_result_tags on its commitment
    expect(res.tool_results.applicable).toBe(false);
    expect(res.tool_results.identical).toBe(false);
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

  it('sets first_divergence to the shorter sequence length when graphs differ only in length', () => {
    const a = bundle({ execution_graph: { nodes: [{ type: 'llm.requested' }, { type: 'llm.completed' }, { type: 'tool.selected' }], edges: [] } });
    const b = bundle({ execution_graph: { nodes: [{ type: 'llm.requested' }, { type: 'llm.completed' }], edges: [] } });
    const res = compareBundles(a, b);
    expect(res.actions.identical).toBe(false);
    expect(res.actions.first_divergence).toBe(2);
  });

  it('catches a divergence in domains contacted even when tools_used matches (regression: outcomes beyond tool names must be compared)', () => {
    const a = bundle({ observations: { domains_contacted: ['evil.example'], tools_used: ['bash'], files_touched: [], processes_spawned: [] } });
    const b = bundle({ observations: { domains_contacted: [], tools_used: ['bash'], files_touched: [], processes_spawned: [] } });
    const res = compareBundles(a, b);
    expect(res.actions.identical).toBe(false);
    expect(res.actions.a_only).toEqual(['evil.example']);
  });

  it('catches a divergence in files touched and processes spawned, all four observation sets together', () => {
    const a = bundle({
      observations: { domains_contacted: [], tools_used: [], files_touched: ['/etc/passwd'], processes_spawned: ['curl'] },
    });
    const b = bundle({ observations: { domains_contacted: [], tools_used: [], files_touched: [], processes_spawned: [] } });
    const res = compareBundles(a, b);
    expect(res.actions.identical).toBe(false);
    expect(res.actions.a_only).toEqual(['/etc/passwd', 'curl']);
    expect(res.actions.b_only).toEqual([]);
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
    // Real counts are preserved even when nothing is comparable.
    expect(res.prompts.count_a).toBe(1);
    expect(res.prompts.count_b).toBe(1);
  });

  it('a partial kid overlap never reports identical, even when every checked position matches (regression: mid-run key rotation must not silently pass)', () => {
    // A commits [T1,T2,T2] under K1. B commits T1 under K1, then rotates
    // to K2 for [T3,T3] - genuinely different from A's T2,T2. Only
    // position 0 shares a key; whoever holds AER_COMMITMENT_KEY for B
    // controls when they rotate, and must not be able to buy a clean
    // "identical:true" by rotating away every position they want
    // unverifiable.
    const a = bundle({
      content_commitments: [
        commitment({ kid: KID_1, prompt_canon_tag: TAG_A1 }),
        commitment({ kid: KID_1, prompt_canon_tag: TAG_A2 }),
        commitment({ kid: KID_1, prompt_canon_tag: TAG_A2 }),
      ],
    });
    const b = bundle({
      content_commitments: [
        commitment({ kid: KID_1, prompt_canon_tag: TAG_A1 }),
        commitment({ kid: KID_2, prompt_canon_tag: TAG_B1 }),
        commitment({ kid: KID_2, prompt_canon_tag: TAG_B1 }),
      ],
    });
    const res = compareBundles(a, b);
    expect(res.comparable).toBe(true);
    expect(res.reason).toBe('partial_kid_overlap');
    expect(res.kid).toBe(KID_1);
    // Position 0 matched, but `identical` must be false: only 1 of 3
    // positions was ever checked, and `identical:true` must never be a
    // claim about anything less than the whole run.
    expect(res.prompts.identical).toBe(false);
    expect(res.prompts.compared).toBe(1);
    expect(res.prompts.count_a).toBe(3);
    expect(res.prompts.count_b).toBe(3);
    // Every tag dimension carries the same partial-coverage refusal, not
    // just prompts.
    expect(res.responses.identical).toBe(false);
    expect(res.tool_args.identical).toBe(false);
    expect(res.tool_results.identical).toBe(false);
    expect(res.wire.identical).toBe(false);
  });

  it('a fully-covered run with a mid-run key rotation on BOTH sides can still report identical', () => {
    // Contrast case: both sides rotate from K1 to K2 at the same position,
    // with matching content throughout. Every position is covered by some
    // shared-key segment, so `compared` reaches count_a/count_b and
    // `identical:true` is an honest claim about the whole run - this is not
    // what partial_kid_overlap is for.
    const a = bundle({
      content_commitments: [
        commitment({ kid: KID_1, prompt_canon_tag: TAG_A1 }),
        commitment({ kid: KID_2, prompt_canon_tag: TAG_A2 }),
      ],
    });
    const b = bundle({
      content_commitments: [
        commitment({ kid: KID_1, prompt_canon_tag: TAG_A1 }),
        commitment({ kid: KID_2, prompt_canon_tag: TAG_A2 }),
      ],
    });
    const res = compareBundles(a, b);
    expect(res.comparable).toBe(true);
    expect(res.reason).toBeUndefined();
    expect(res.prompts.identical).toBe(true);
    expect(res.prompts.compared).toBe(2);
  });

  it('reports the kid as null when more than one distinct kid is shared across comparable positions', () => {
    const a = bundle({ content_commitments: [commitment({ kid: KID_1 }), commitment({ kid: KID_2, prompt_canon_tag: TAG_A2 })] });
    const b = bundle({ content_commitments: [commitment({ kid: KID_1 }), commitment({ kid: KID_2, prompt_canon_tag: TAG_A2 })] });
    const res = compareBundles(a, b);
    expect(res.comparable).toBe(true);
    expect(res.kid).toBeNull();
    expect(res.prompts.identical).toBe(true);
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
