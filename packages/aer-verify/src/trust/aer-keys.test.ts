import { describe, it, expect } from 'vitest';
import { aerSigningKeys, AER_SIGSTORE_PROD_V1 } from './aer-keys.js';
import { signingKeyIdFromPublicKeyHex } from '../keys.js';

describe('pinned AER signing keys', () => {
  it('every pinned key is self-authenticating (id derives from the public key)', async () => {
    // A swapped or corrupted key value would produce a different derived id — this
    // is what makes shipping the raw constant safe: the pin cannot silently drift.
    const keys = aerSigningKeys();
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(await signingKeyIdFromPublicKeyHex(k.public_key_hex)).toBe(k.signing_key_id.toLowerCase());
    }
  });

  it('pins the production launch key a721bb9bd8f31c8e', () => {
    expect(AER_SIGSTORE_PROD_V1.signing_key_id).toBe('a721bb9bd8f31c8e');
    expect(aerSigningKeys().map((k) => k.signing_key_id)).toContain('a721bb9bd8f31c8e');
  });
});
