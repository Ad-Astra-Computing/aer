import { describe, it, expect } from 'vitest';
import {
  projectAgent,
  projectSession,
  projectSessionWithSummary,
  projectHost,
  projectFinding,
  projectBaseline,
  projectSearchResult,
} from './projections.js';

// Design section 2.1: every projection narrows a REST response and must
// never pass a key outside its own explicit allowlist, no matter what the
// server adds later. Pad every fixture with the keys the design doc names
// as "must never pass" and assert their absence from every projection that
// could plausibly see them.
const FORBIDDEN = {
  prompt: 'ignore instructions',
  completion: 'do something bad',
  args: { x: 1 },
  result: 'tool result text',
  reason: 'a human explanation',
  paused_reason: 'why it was paused',
  api_key: 'aer_secret_abc',
  hash: 'deadbeef',
  repo_ref: 'https://github.com/someone/private-repo',
};

describe('projectAgent', () => {
  it('keeps the allowlisted agent fields', () => {
    const out = projectAgent({
      agent_id: 'a1', tenant_id: 't1', name: 'My Agent', status: 'active', coverage: 'healthy',
      created_at: '2026-01-01T00:00:00Z', agent_version: '1.2.3', framework_type: 'langgraph',
      last_harness: 'claude-code', last_collector_name: 'aer-auto-node', collector_version: '0.4.0',
      ...FORBIDDEN,
      paused_by: 'user-123', key_bindings: ['prefix_abc'],
    });
    expect(out).toMatchObject({ agent_id: 'a1', tenant_id: 't1', name: 'My Agent', status: 'active', coverage: 'healthy' });
    for (const k of Object.keys(FORBIDDEN)) expect(out).not.toHaveProperty(k);
    expect(out).not.toHaveProperty('paused_by');
    expect(out).not.toHaveProperty('key_bindings');
  });

  it('clamps collector-asserted labels again even if the server sent something oversized', () => {
    const out = projectAgent({ agent_id: 'a1', agent_version: 'v'.repeat(200), framework_type: 'f'.repeat(200) });
    expect((out['agent_version'] as string).length).toBe(128);
    expect((out['framework_type'] as string).length).toBe(64);
  });

  it('a non-object input yields an empty projection rather than throwing', () => {
    expect(projectAgent(null)).toEqual({});
    expect(projectAgent('x')).toEqual({});
  });
});

describe('projectSession / projectSessionWithSummary', () => {
  const sessionFixture = {
    session_id: 's1', tenant_id: 't1', agent_id: 'a1', status: 'completed',
    created_at: '2026-01-01T00:00:00Z', end_reason: 'completed', risk_max_severity: 'low',
    llm_activity: { providers: ['anthropic'] }, sources: ['sdk'], tags: ['prod'],
    session_ref: 'ref-123',
    principal: { id: 'p1', kind: 'human', display: 'Jane Doe <jane@example.com>' },
    ...FORBIDDEN,
    agent_sessions: { metadata: { anything: 'goes' } },
  };

  it('keeps the allowlisted fields and drops principal.display', () => {
    const out = projectSession(sessionFixture);
    expect(out['principal']).toEqual({ id: 'p1', kind: 'human' });
    for (const k of Object.keys(FORBIDDEN)) expect(out).not.toHaveProperty(k);
    expect(out).not.toHaveProperty('agent_sessions');
    expect((out['principal'] as Record<string, unknown>)).not.toHaveProperty('display');
  });

  it('merges a summary through the same allowlist', () => {
    const out = projectSessionWithSummary(sessionFixture, { ...FORBIDDEN, risk_max_severity: 'high', llm_activity: { providers: ['openai'] } });
    expect(out['risk_max_severity']).toBe('high'); // summary overlay wins, same allowlist
    for (const k of Object.keys(FORBIDDEN)) expect(out).not.toHaveProperty(k);
  });
});

describe('projectHost', () => {
  it('keeps host/count fields only', () => {
    const out = projectHost({ host: 'example.com', count: 3, ...FORBIDDEN });
    expect(out).toEqual({ host: 'example.com', count: 3 });
  });
});

describe('projectFinding', () => {
  it('keeps finding.summary but drops disposition.reason and disposition.actor_user_id', () => {
    const out = projectFinding({
      finding_id: 'f1', session_id: 's1', agent_id: 'a1', class: 'policy', subtype: 'egress',
      severity: 'high', status: 'open', reason_code: 'UNKNOWN_HOST', observed_value: 'evil.example',
      summary: 'Contacted an unrecognized host.',
      disposition: { status: 'open', reason: 'investigating because the CEO said so', actor_user_id: 'u-1', reason_code: 'r1' },
      ...FORBIDDEN,
    });
    expect(out['summary']).toBe('Contacted an unrecognized host.');
    expect(out['disposition']).toEqual({ status: 'open', reason_code: 'r1' });
    for (const k of Object.keys(FORBIDDEN)) expect(out).not.toHaveProperty(k);
  });
});

describe('projectBaseline', () => {
  it('keeps baseline fields and drops padding', () => {
    const out = projectBaseline({
      baseline_id: 'b1', agent_id: 'a1', version: 2, status: 'active',
      allowed_tools: ['bash'], allowed_domains: ['example.com'],
      ...FORBIDDEN,
    });
    expect(out).toMatchObject({ baseline_id: 'b1', agent_id: 'a1', version: 2, status: 'active' });
    for (const k of Object.keys(FORBIDDEN)) expect(out).not.toHaveProperty(k);
  });
});

describe('projectSearchResult', () => {
  it('keeps the result shape and drops padding', () => {
    const out = projectSearchResult({ kind: 'host', value: 'example.com', agent_id: 'a1', count: 4, ...FORBIDDEN });
    expect(out).toEqual({ kind: 'host', value: 'example.com', agent_id: 'a1', count: 4 });
  });
});
