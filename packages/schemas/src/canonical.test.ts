import { describe, it, expect } from 'vitest';
import { canonicalize, canonicalHash } from './canonical.js';

describe('canonicalize (json-c14n-v1)', () => {
  it('sorts object keys lexicographically', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts nested object keys', () => {
    expect(canonicalize({ z: { b: 1, a: 2 }, a: 3 })).toBe('{"a":3,"z":{"a":2,"b":1}}');
  });

  it('preserves array order (semantic)', () => {
    expect(canonicalize({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
  });

  it('emits explicit null', () => {
    expect(canonicalize({ a: null })).toBe('{"a":null}');
  });

  it('is stable across key-insertion orders (same logical object → same bytes)', () => {
    const a = { x: { q: 1, p: 2 }, y: [1, 2, 3], z: 'hi' };
    const b = { z: 'hi', y: [1, 2, 3], x: { p: 2, q: 1 } };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('rejects non-finite numbers (NaN, Infinity) — not JSON-safe', () => {
    expect(() => canonicalize({ a: NaN })).toThrow();
    expect(() => canonicalize({ a: Infinity })).toThrow();
    expect(() => canonicalize({ a: -Infinity })).toThrow();
  });

  it('rejects undefined values (would be dropped and produce non-deterministic bytes)', () => {
    expect(() => canonicalize({ a: undefined })).toThrow();
  });

  it('rejects functions and symbols', () => {
    expect(() => canonicalize({ a: () => 1 })).toThrow();
    expect(() => canonicalize({ a: Symbol('x') })).toThrow();
  });

  it('rejects bigint (not JSON-representable without lossy conversion)', () => {
    expect(() => canonicalize({ a: 1n })).toThrow();
  });

  it('handles unicode as UTF-8 (no escape collapsing issues)', () => {
    expect(canonicalize({ a: 'café 🐈' })).toBe('{"a":"café 🐈"}');
  });
});

describe('canonicalHash', () => {
  it('returns a 64-char hex sha256', () => {
    const h = canonicalHash({ a: 1 });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for logically-equal objects with different key orders', () => {
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
  });

  it('differs for different objects', () => {
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
  });
});
