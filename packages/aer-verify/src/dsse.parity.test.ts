import { describe, it, expect } from 'vitest';
import {
  paeBytes as genPae,
  buildDsseEnvelope,
  createInMemorySigner,
  ATTESTATION_SCHEMA,
  type AttestationPayload as GenAttestation,
} from '@aer-oss/attestation-test-utils';
import { paeBytes, verifyDsseEnvelope, decodeAttestation } from './dsse.js';
import { subtleEd25519Verify } from './keys.js';

describe('paeBytes parity with the generator', () => {
  const cases: Array<[string, string]> = [
    ['application/vnd.aer.attestation+json', '{"a":1}'],
    ['', ''],
    ['t', 'unicode payload: café 🚀'],
  ];
  for (const [type, payload] of cases) {
    it(`PAE(${JSON.stringify(type)}, …) is byte-identical`, () => {
      const p = new TextEncoder().encode(payload);
      expect(Array.from(paeBytes(type, p))).toEqual(Array.from(genPae(type, p)));
    });
  }
});

describe('verifyDsseEnvelope + decodeAttestation against a generator-built envelope', () => {
  const attestation: GenAttestation = {
    _type: ATTESTATION_SCHEMA,
    aer_id: 'aer_test_1',
    canonical_hash: 'a'.repeat(64),
    signing_key_id: '0123456789abcdef',
    signed_at: '2026-07-20T00:00:00.000Z',
  };

  it('verifies a genuine envelope and decodes its payload', async () => {
    const signer = createInMemorySigner();
    const envelope = await buildDsseEnvelope(attestation, signer);

    expect(await verifyDsseEnvelope(envelope, signer.publicKey(), subtleEd25519Verify)).toBe(true);
    expect(decodeAttestation(envelope)).toEqual(attestation);
  });

  it('rejects an envelope signed by a different key', async () => {
    const signer = createInMemorySigner();
    const other = createInMemorySigner();
    const envelope = await buildDsseEnvelope(attestation, signer);
    expect(await verifyDsseEnvelope(envelope, other.publicKey(), subtleEd25519Verify)).toBe(false);
  });

  it('rejects an envelope whose payload was swapped after signing', async () => {
    const signer = createInMemorySigner();
    const envelope = await buildDsseEnvelope(attestation, signer);
    const forged = { ...attestation, canonical_hash: 'b'.repeat(64) };
    envelope.payload = btoa(JSON.stringify(forged));
    expect(await verifyDsseEnvelope(envelope, signer.publicKey(), subtleEd25519Verify)).toBe(false);
  });

  it('rejects an envelope with more than one signature', async () => {
    const signer = createInMemorySigner();
    const envelope = await buildDsseEnvelope(attestation, signer);
    envelope.signatures.push({ sig: envelope.signatures[0]!.sig });
    expect(await verifyDsseEnvelope(envelope, signer.publicKey(), subtleEd25519Verify)).toBe(false);
  });

  it('decodeAttestation never throws on a deeply-nested payload, even one that is otherwise well-formed JSON', () => {
    // Built by string concatenation (iteratively), not JSON.stringify on a nested
    // object. JSON.stringify is itself recursive and would overflow the stack
    // building the fixture, before decodeAttestation ever sees it.
    const depth = 20000;
    const nestedJson = '{"a":'.repeat(depth) + '1' + '}'.repeat(depth);
    const envelope = {
      payloadType: 'application/vnd.aer.attestation+json',
      payload: btoa(nestedJson),
      signatures: [{ sig: btoa('x') }],
    };
    expect(() => decodeAttestation(envelope)).not.toThrow();
    expect(decodeAttestation(envelope)).toBeNull();
  });
});
