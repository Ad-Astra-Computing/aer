import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { deriveClientRef, CLIENT_REF_PATTERN } from './client-ref.js';

describe('deriveClientRef', () => {
  it('is deterministic for the same inputs', () => {
    const a = deriveClientRef('claude-code', 'ses_abc123', 'agent-1');
    const b = deriveClientRef('claude-code', 'ses_abc123', 'agent-1');
    expect(a).toBe(b);
  });

  it('starts with the version prefix and matches the server pattern', () => {
    const ref = deriveClientRef('claude-code', 'ses_abc123', 'agent-1');
    expect(ref.startsWith('v1:')).toBe(true);
    expect(ref.length).toBeLessThanOrEqual(128);
    expect(ref.length).toBeGreaterThanOrEqual(16);
    expect(CLIENT_REF_PATTERN.test(ref)).toBe(true);
  });

  it('is exactly "v1:" plus 48 hex characters (the spec truncation)', () => {
    const ref = deriveClientRef('codex', 'root-1', 'agent-2');
    expect(ref).toMatch(/^v1:[0-9a-f]{48}$/);
  });

  it('differs when the harness differs', () => {
    const a = deriveClientRef('claude-code', 'root-1', 'agent-1');
    const b = deriveClientRef('codex', 'root-1', 'agent-1');
    expect(a).not.toBe(b);
  });

  it('differs when the root session id differs', () => {
    const a = deriveClientRef('claude-code', 'root-1', 'agent-1');
    const b = deriveClientRef('claude-code', 'root-2', 'agent-1');
    expect(a).not.toBe(b);
  });

  it('differs when the agent id differs', () => {
    const a = deriveClientRef('claude-code', 'root-1', 'agent-1');
    const b = deriveClientRef('claude-code', 'root-1', 'agent-2');
    expect(a).not.toBe(b);
  });

  it('is stable against a known vector (regression pin)', () => {
    // Recomputed independently with node:crypto sha256 over
    // "aer-client-ref.v1\nclaude-code\nroot-1\nagent-1" and truncated to 48
    // hex chars. Pinned so a change to the derivation is never silent.
    const ref = deriveClientRef('claude-code', 'root-1', 'agent-1');
    expect(ref).toBe(
      'v1:' +
        createHash('sha256')
          .update('aer-client-ref.v1\nclaude-code\nroot-1\nagent-1')
          .digest('hex')
          .slice(0, 48),
    );
  });

  it('never throws on empty or unusual inputs', () => {
    expect(() => deriveClientRef('claude-code', '', '')).not.toThrow();
    expect(() => deriveClientRef('claude-code', 'a'.repeat(500), 'b'.repeat(500))).not.toThrow();
  });
});
