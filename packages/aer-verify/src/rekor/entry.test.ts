import { describe, it, expect } from 'vitest';
import { leafHashFromUuid, treeShardFromUuid } from './entry.js';
import { bytesToHex } from '../bytes.js';

const leaf = '108e9186e8c5677aa11a457a710164ea1fffa7e801858ba304b8478c9dd2abcd';
const shard = '1193050959916656506'.padStart(16, '0').slice(0, 16); // placeholder 16 hex
const sharded = 'abcdef0123456789' + leaf;

describe('Rekor entry UUID -> leaf hash', () => {
  it('returns the 32-byte leaf hash from an unsharded 64-hex UUID', () => {
    const h = leafHashFromUuid(leaf);
    expect(h).toHaveLength(32);
    expect(bytesToHex(h)).toBe(leaf);
  });

  it('takes the trailing 32 bytes from a sharded 80-hex UUID', () => {
    const h = leafHashFromUuid(sharded);
    expect(bytesToHex(h)).toBe(leaf);
  });

  it('extracts the 8-byte tree shard from an 80-hex UUID', () => {
    expect(bytesToHex(treeShardFromUuid(sharded)!)).toBe('abcdef0123456789');
  });

  it('returns null shard for an unsharded UUID', () => {
    expect(treeShardFromUuid(leaf)).toBeNull();
  });

  it('rejects a UUID of the wrong length', () => {
    expect(() => leafHashFromUuid('abcd')).toThrow(/64- or 80-hex/);
  });

  it('rejects a non-hex UUID', () => {
    expect(() => leafHashFromUuid('z'.repeat(64))).toThrow();
  });

  // Keep the placeholder referenced so lint/tsc don't flag it.
  it('has a shard placeholder of expected width', () => {
    expect(shard).toHaveLength(16);
  });
});
