import { describe, it, expect } from 'vitest';
import {
  AerBundle,
  ExecutionGraph,
  Integrity,
  stripIntegrity,
  hashBundleForSigning,
} from './aer.js';
import { newUuidV7 } from './id.js';
import { canonicalHash } from './canonical.js';

const validGraph = {
  nodes: [
    { id: newUuidV7(), type: 'session.started', timestamp: '2026-04-20T14:11:00.000Z', payload_digest: 'a'.repeat(64) },
    { id: newUuidV7(), type: 'session.ended', timestamp: '2026-04-20T14:11:10.000Z', payload_digest: 'b'.repeat(64) },
  ],
  edges: [
    { from: 'from-id-1', to: 'from-id-2', kind: 'temporal' as const },
  ],
};

const validIntegrity = {
  canonicalization: 'json-c14n-v1' as const,
  hash_alg: 'sha256' as const,
  hash: 'c'.repeat(64),
  sig_alg: 'ed25519' as const,
  signature: Buffer.alloc(64).toString('base64'),
  signing_key_id: '0123456789abcdef',
  anchored: false,
};

function baseBundle() {
  return {
    schema_version: 'aer.v1' as const,
    aer_id: newUuidV7(),
    tenant_id: newUuidV7(),
    agent_id: newUuidV7(),
    agent_version: '1.0.0',
    agent_session_id: newUuidV7(),
    time_window: {
      start: '2026-04-20T14:11:00.000Z',
      end: '2026-04-20T14:11:45.000Z',
    },
    environment: {
      name: 'test',
      host_ids: [],
      container_ids: [],
    },
    correlation: {
      session_confidence: 0.97,
      sources: ['wrapper' as const],
    },
    execution_graph: validGraph,
    observations: {
      domains_contacted: [],
      tools_used: [],
      files_touched: [],
      processes_spawned: [],
    },
    deviations: [],
    impact_summary: {
      classes: [],
      highest_severity: 'info' as const,
    },
    policy_decisions: [],
    integrity: validIntegrity,
    exports: {
      prov_available: false,
      human_report_available: false,
    },
  };
}

describe('AerBundle', () => {
  it('accepts a minimally-valid bundle', () => {
    expect(AerBundle.safeParse(baseBundle()).success).toBe(true);
  });

  it('rejects an absurdly long observation string (amplification defense)', () => {
    const b = baseBundle();
    b.observations.domains_contacted = ['a'.repeat(65_537)];
    expect(AerBundle.safeParse(b).success).toBe(false);
  });

  it('rejects an absurdly long impact_summary class (amplification defense)', () => {
    const b = baseBundle();
    b.impact_summary.classes = ['a'.repeat(65_537)];
    expect(AerBundle.safeParse(b).success).toBe(false);
  });

  it('rejects an absurdly long llm_activity model name (amplification defense)', () => {
    const b = {
      ...baseBundle(),
      llm_activity: {
        providers: [
          {
            provider: 'openai',
            calls: 1,
            completed: 1,
            errors: 0,
            streaming: 0,
            input_tokens: 0,
            output_tokens: 0,
            tokens_observed: false,
            models: ['a'.repeat(65_537)],
            tool_selections: 0,
          },
        ],
        totals: {
          calls: 1,
          completed: 1,
          errors: 0,
          streaming: 0,
          input_tokens: 0,
          output_tokens: 0,
          tokens_observed: false,
          tool_selections: 0,
        },
        tools: [],
      },
    };
    expect(AerBundle.safeParse(b).success).toBe(false);
  });

  it('rejects wrong schema_version', () => {
    const b = { ...baseBundle(), schema_version: 'aer.v2' };
    expect(AerBundle.safeParse(b).success).toBe(false);
  });

  it('rejects unknown top-level keys', () => {
    const b = { ...baseBundle(), surprise: 'value' };
    expect(AerBundle.safeParse(b).success).toBe(false);
  });

  it('rejects end before start in time_window', () => {
    const b = {
      ...baseBundle(),
      time_window: { start: '2026-04-20T14:11:45.000Z', end: '2026-04-20T14:11:00.000Z' },
    };
    expect(AerBundle.safeParse(b).success).toBe(false);
  });

  it('rejects session_confidence outside [0,1]', () => {
    const b = { ...baseBundle(), correlation: { session_confidence: 1.5, sources: ['sdk' as const] } };
    expect(AerBundle.safeParse(b).success).toBe(false);
  });

  it('rejects non-64-hex canonical hash', () => {
    const b = { ...baseBundle(), integrity: { ...validIntegrity, hash: 'tooshort' } };
    expect(AerBundle.safeParse(b).success).toBe(false);
  });

  it('rejects unknown sig_alg', () => {
    const b = { ...baseBundle(), integrity: { ...validIntegrity, sig_alg: 'rsa' } };
    expect(AerBundle.safeParse(b).success).toBe(false);
  });

  it('requires signing_key_id to be hex', () => {
    const b = { ...baseBundle(), integrity: { ...validIntegrity, signing_key_id: 'not-hex!' } };
    expect(AerBundle.safeParse(b).success).toBe(false);
  });
});

describe('ExecutionGraph', () => {
  it('accepts an empty graph', () => {
    expect(ExecutionGraph.safeParse({ nodes: [], edges: [] }).success).toBe(true);
  });

  it('rejects a node payload_digest of wrong length', () => {
    expect(
      ExecutionGraph.safeParse({
        nodes: [{ id: newUuidV7(), type: 'x', timestamp: '2026-04-20T14:11:00.000Z', payload_digest: 'abc' }],
        edges: [],
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown edge kind', () => {
    expect(
      ExecutionGraph.safeParse({
        nodes: [],
        edges: [{ from: 'a', to: 'b', kind: 'bogus' }],
      }).success,
    ).toBe(false);
  });
});

describe('Integrity', () => {
  it('accepts a valid block', () => {
    expect(Integrity.safeParse(validIntegrity).success).toBe(true);
  });

  it('rejects missing fields', () => {
    const { signing_key_id: _, ...rest } = validIntegrity;
    expect(Integrity.safeParse(rest).success).toBe(false);
  });
});

describe('stripIntegrity', () => {
  it('returns the bundle with integrity removed', () => {
    const b = baseBundle();
    const stripped = stripIntegrity(b);
    expect('integrity' in stripped).toBe(false);
    expect(stripped.aer_id).toBe(b.aer_id);
  });

  it('does not mutate the input', () => {
    const b = baseBundle();
    const before = JSON.stringify(b);
    stripIntegrity(b);
    expect(JSON.stringify(b)).toBe(before);
  });
});

describe('hashBundleForSigning', () => {
  it('is stable across field-insertion order (canonicalization)', () => {
    const a = baseBundle();
    const b = baseBundle();
    // Shuffle top-level keys on b by round-tripping through a different order
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as typeof a;
    reordered.aer_id = b.aer_id;
    reordered.tenant_id = b.tenant_id;
    reordered.agent_id = b.agent_id;
    reordered.agent_session_id = b.agent_session_id;
    reordered.execution_graph.nodes = [...b.execution_graph.nodes];
    expect(hashBundleForSigning(a)).toBe(hashBundleForSigning({ ...reordered, aer_id: a.aer_id, tenant_id: a.tenant_id, agent_id: a.agent_id, agent_session_id: a.agent_session_id, execution_graph: a.execution_graph }));
  });

  it('ignores the existing integrity block', () => {
    const a = baseBundle();
    const b = { ...a, integrity: { ...validIntegrity, hash: 'f'.repeat(64) } };
    expect(hashBundleForSigning(a)).toBe(hashBundleForSigning(b));
  });

  it('returns a 64-hex sha256 digest', () => {
    expect(hashBundleForSigning(baseBundle())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches a manual canonicalHash over the stripped bundle', () => {
    const b = baseBundle();
    expect(hashBundleForSigning(b)).toBe(canonicalHash(stripIntegrity(b)));
  });

  it('changes when observable content changes', () => {
    const a = baseBundle();
    const b = { ...a, agent_version: '9.9.9' };
    expect(hashBundleForSigning(a)).not.toBe(hashBundleForSigning(b));
  });
});
