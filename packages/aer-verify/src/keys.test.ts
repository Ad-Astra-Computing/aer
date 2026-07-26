import { describe, it, expect } from 'vitest';
import { signingKeyIdFromPublicKey as genKid, createInMemorySigner } from '@aer-oss/attestation-test-utils';
import { signingKeyIdFromPublicKey, subtleEd25519Verify, rawEd25519ToSpki } from './keys.js';

describe('signingKeyIdFromPublicKey parity with the generator', () => {
  it('derives the same key-id the server signs bundles with', async () => {
    const signer = createInMemorySigner();
    const pub = signer.publicKey();
    expect(await signingKeyIdFromPublicKey(pub)).toBe(genKid(pub));
  });

  it('is a stable 16-hex-char id', async () => {
    const signer = createInMemorySigner();
    const kid = await signingKeyIdFromPublicKey(signer.publicKey());
    expect(kid).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('subtleEd25519Verify', () => {
  it('accepts a genuine signature and rejects a tampered one', async () => {
    const signer = createInMemorySigner();
    const pub = signer.publicKey();
    const msg = new TextEncoder().encode('the message that was signed');
    const sig = await signer.sign(msg);

    expect(await subtleEd25519Verify(pub, msg, sig)).toBe(true);

    const tampered = new Uint8Array(sig);
    tampered[0] ^= 0xff;
    expect(await subtleEd25519Verify(pub, msg, tampered)).toBe(false);

    const wrongMsg = new TextEncoder().encode('a different message');
    expect(await subtleEd25519Verify(pub, wrongMsg, sig)).toBe(false);
  });

  it('wraps a raw key in a 44-byte SPKI (12-byte prefix + 32-byte key)', () => {
    const spki = rawEd25519ToSpki(new Uint8Array(32));
    expect(spki.length).toBe(44);
  });
});
