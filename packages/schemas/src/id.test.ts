import { describe, it, expect } from 'vitest';
import { Uuid, newUuidV7, isUuidV7 } from './id.js';

describe('Uuid schema', () => {
  it('accepts RFC 4122 UUIDs (any version)', () => {
    expect(Uuid.safeParse('550e8400-e29b-41d4-a716-446655440000').success).toBe(true);
  });

  it('accepts UUIDv7', () => {
    const id = newUuidV7();
    expect(Uuid.safeParse(id).success).toBe(true);
  });

  it('rejects non-UUID strings', () => {
    expect(Uuid.safeParse('not-a-uuid').success).toBe(false);
    expect(Uuid.safeParse('').success).toBe(false);
  });

  it('rejects uppercase (we canonicalize to lowercase)', () => {
    expect(Uuid.safeParse('550E8400-E29B-41D4-A716-446655440000').success).toBe(false);
  });
});

describe('newUuidV7', () => {
  it('returns a UUIDv7 with version nibble 7', () => {
    const id = newUuidV7();
    expect(id.charAt(14)).toBe('7');
  });

  it('is monotonically sortable across successive calls', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      ids.push(newUuidV7());
      await new Promise((r) => setTimeout(r, 2));
    }
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it('encodes a timestamp close to now in the prefix', () => {
    const before = Date.now();
    const id = newUuidV7();
    const after = Date.now();
    const hex = id.replace(/-/g, '').slice(0, 12);
    const tsMs = parseInt(hex, 16);
    expect(tsMs).toBeGreaterThanOrEqual(before);
    expect(tsMs).toBeLessThanOrEqual(after);
  });
});

describe('isUuidV7', () => {
  it('returns true for v7 ids', () => {
    expect(isUuidV7(newUuidV7())).toBe(true);
  });

  it('returns false for v4 ids', () => {
    expect(isUuidV7('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
  });

  it('returns false for garbage', () => {
    expect(isUuidV7('not-a-uuid')).toBe(false);
  });
});
