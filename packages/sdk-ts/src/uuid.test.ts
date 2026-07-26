import { describe, it, expect } from 'vitest';
import { newUuidV7 } from './uuid.js';

describe('newUuidV7', () => {
  it('produces RFC 9562 v7 UUIDs', () => {
    const u = newUuidV7();
    expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(u.charAt(14)).toBe('7');           // version nibble
    expect(u.charAt(19)).toMatch(/^[89ab]$/); // variant bits
  });

  it('emits strictly increasing values within the same millisecond', () => {
    // Generate a small burst back-to-back. They should be lexicographically sortable.
    const ids = Array.from({ length: 50 }, () => newUuidV7());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it('produces unique values across many calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(newUuidV7());
    expect(ids.size).toBe(1000);
  });
});
