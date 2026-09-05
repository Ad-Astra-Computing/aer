import { describe, it, expect } from 'vitest';
import { canonicalize as schemasCanonicalize, canonicalHash as schemasHash } from '@aer/schemas';
import { canonicalize, canonicalHash } from './canonical.js';

// The verifier core carries its own node:crypto-free copy of json-c14n-v1 so it
// runs in browsers and Workers. If it ever diverges from @aer/schemas, bundles
// signed by the server would fail to verify (or worse, a tampered bundle would
// pass). This golden test asserts byte-identical output on a battery of inputs and
// MUST block merge on any drift.
const CASES: unknown[] = [
  null,
  true,
  false,
  0,
  -0,
  1,
  -1,
  1.5,
  1e21,
  123456789.123456789,
  '',
  'plain',
  'quote"and\\backslash',
  'unicode: café · 日本語 ·  control',
  'emoji 🚀 (astral, but as a value not a key)',
  [],
  [1, 2, 3],
  ['b', 'a', 'c'],
  {},
  { a: 1, b: 2 },
  { b: 2, a: 1 }, // key order must normalize identically
  { z: { y: { x: [3, 2, 1] } }, a: null },
  { '': 'empty key', ' ': 'space key', '0': 'digit key' },
  {
    aer_id: 'aer_123',
    session: { start: '2026-07-20T00:00:00.000Z', events: [{ t: 'a' }, { t: 'b' }] },
    observations: { domains_contacted: ['api.openai.com', 'api.anthropic.com'], tools_used: [] },
    nested: { deep: { deeper: { deepest: true } } },
  },
];

describe('canonicalize parity with @aer/schemas', () => {
  for (const [i, value] of CASES.entries()) {
    it(`case ${i} produces identical canonical bytes`, () => {
      expect(canonicalize(value)).toBe(schemasCanonicalize(value));
    });
  }

  it('rejects the same non-JSON-safe values', () => {
    expect(() => canonicalize(undefined)).toThrow();
    expect(() => canonicalize(NaN)).toThrow();
    expect(() => canonicalize(Infinity)).toThrow();
    expect(() => canonicalize(10n)).toThrow();
    expect(() => canonicalize(new Date())).toThrow();
  });
});

describe('canonicalize depth bound', () => {
  function nest(depth: number): unknown {
    let node: Record<string, unknown> = {};
    const root = node;
    for (let i = 0; i < depth; i++) {
      const next: Record<string, unknown> = {};
      node.next = next;
      node = next;
    }
    return root;
  }

  it('canonicalizes a document right at the depth limit', () => {
    expect(() => canonicalize(nest(256))).not.toThrow();
  });

  it('throws a predictable TypeError past the depth limit instead of a stack-overflow RangeError', () => {
    expect(() => canonicalize(nest(20000))).toThrow(TypeError);
    expect(() => canonicalize(nest(20000))).toThrow(/max depth/);
  });
});

describe('canonicalHash parity with @aer/schemas', () => {
  for (const [i, value] of CASES.entries()) {
    it(`case ${i} hashes identically`, async () => {
      expect(await canonicalHash(value)).toBe(schemasHash(value));
    });
  }
});
