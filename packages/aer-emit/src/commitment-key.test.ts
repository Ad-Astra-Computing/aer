import { describe, it, expect } from 'vitest';
import {
  commitmentKeyFromString, deriveKid, hashFileDigest, hashFileDigestSync, FILE_DIGEST_DOMAIN,
} from './commitment-key.js';

// Fixed test vectors (key, bytes, expected tag; key, expected kid). These
// pin the aer-file-digest.v1 byte layout the design requires be fixed once
// and never changed. The SAME vectors (key = 32 bytes of 0x01, text "hello
// world") are asserted in aer-hooks's hashable-path-classes/digest gate
// tests. Keep both in sync if either ever changes, which should be never.
const VECTOR_KEY = Buffer.alloc(32, 0x01);
const VECTOR_KID = '9f4cf7d8f8f38243';
const VECTOR_TEXT_TAG = '46b5cdf815859bf739f6d07509de297df65d5444ea08193bb933e2c22492e7ed';
const VECTOR_EMPTY_TAG = '4e9525da6ab3784bb181cf7fce4c453aeee293676d1e5d66d0b0dc38203cd8b6';

describe('FILE_DIGEST_DOMAIN', () => {
  it('is the fixed aer-file-digest.v1 domain tag', () => {
    expect(FILE_DIGEST_DOMAIN).toBe('aer-file-digest.v1');
  });
});

describe('commitmentKeyFromString', () => {
  it('accepts a 64-hex key', () => {
    const key = commitmentKeyFromString('a'.repeat(64));
    expect(key).not.toBeNull();
    expect(key!.length).toBe(32);
  });

  it('accepts a base64 key of at least 32 bytes', () => {
    const key = commitmentKeyFromString(Buffer.alloc(32, 7).toString('base64'));
    expect(key).not.toBeNull();
    expect(key!.length).toBe(32);
  });

  it('accepts a base64url key of at least 32 bytes', () => {
    const key = commitmentKeyFromString(Buffer.alloc(32, 7).toString('base64url'));
    expect(key).not.toBeNull();
    expect(key!.length).toBe(32);
  });

  it('rejects undefined, empty, too-short, or malformed input rather than silently accepting a weak key', () => {
    expect(commitmentKeyFromString(undefined)).toBeNull();
    expect(commitmentKeyFromString(null)).toBeNull();
    expect(commitmentKeyFromString('')).toBeNull();
    expect(commitmentKeyFromString('a'.repeat(16))).toBeNull(); // too short even as hex
    expect(commitmentKeyFromString('not valid at all !!')).toBeNull();
  });
});

describe('deriveKid', () => {
  it('matches the fixed kid vector', () => {
    expect(deriveKid(VECTOR_KEY)).toBe(VECTOR_KID);
  });

  it('is deterministic and key-sensitive', () => {
    expect(deriveKid(VECTOR_KEY)).toBe(deriveKid(VECTOR_KEY));
    expect(deriveKid(Buffer.alloc(32, 0x02))).not.toBe(VECTOR_KID);
  });
});

describe('hashFileDigestSync / hashFileDigest', () => {
  it('matches the fixed file-digest vector for "hello world"', () => {
    const { hex, bytes } = hashFileDigestSync(VECTOR_KEY, Buffer.from('hello world', 'utf8'));
    expect(hex).toBe(VECTOR_TEXT_TAG);
    expect(bytes).toBe(11);
  });

  it('has a defined, non-empty-preimage tag for zero-byte content', () => {
    const { hex, bytes } = hashFileDigestSync(VECTOR_KEY, Buffer.alloc(0));
    expect(hex).toBe(VECTOR_EMPTY_TAG);
    expect(bytes).toBe(0);
  });

  it('streamed hashFileDigest matches the sync vector over multiple chunks', async () => {
    async function* chunks(): AsyncIterable<Uint8Array> {
      yield Buffer.from('hello ', 'utf8');
      yield Buffer.from('world', 'utf8');
    }
    const { hex, bytes } = await hashFileDigest(VECTOR_KEY, chunks());
    expect(hex).toBe(VECTOR_TEXT_TAG);
    expect(bytes).toBe(11);
  });

  it('never fully buffers: streamed result is independent of chunk boundaries', async () => {
    async function* perByte(): AsyncIterable<Uint8Array> {
      for (const b of Buffer.from('hello world', 'utf8')) yield Buffer.from([b]);
    }
    const { hex } = await hashFileDigest(VECTOR_KEY, perByte());
    expect(hex).toBe(VECTOR_TEXT_TAG);
  });

  it('is a separate HMAC domain from aer-canon.v1 / aer-wire.v1 (cannot collide with a JSON-object preimage)', () => {
    // Every canonValue(...) preimage begins with '{'; the file-digest preimage
    // begins with the fixed ASCII domain string, so the two spaces cannot
    // overlap by construction. This is a structural assertion of that
    // separation, not a negative hash test.
    expect(FILE_DIGEST_DOMAIN.startsWith('{')).toBe(false);
  });
});
