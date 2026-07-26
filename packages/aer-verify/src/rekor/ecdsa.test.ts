import { describe, it, expect } from 'vitest';
import { derToP1363, subtleP256Verify } from './ecdsa.js';

// Encode a P1363 (r||s) signature as DER, the inverse of derToP1363, so we can feed
// the verifier the Rekor wire form from a subtle-generated signature.
function p1363ToDer(p1363: Uint8Array): Uint8Array {
  const enc = (b: Uint8Array): Uint8Array => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.subarray(i);
    if (v[0]! & 0x80) v = new Uint8Array([0, ...v]);
    return new Uint8Array([0x02, v.length, ...v]);
  };
  const r = enc(p1363.subarray(0, 32));
  const s = enc(p1363.subarray(32));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

async function freshKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  return { pair, spki };
}

const msg = new TextEncoder().encode('rekor.sigstore.dev - 1\n42\ncm9vdA==\n');

describe('ECDSA P-256 DER <-> P1363', () => {
  it('round-trips a real subtle signature through DER', async () => {
    const { pair } = await freshKey();
    const p1363 = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, msg),
    );
    const der = p1363ToDer(p1363);
    expect(Array.from(derToP1363(der))).toEqual(Array.from(p1363));
  });

  it('verifies a signature supplied in DER form', async () => {
    const { pair, spki } = await freshKey();
    const p1363 = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, msg),
    );
    expect(await subtleP256Verify(spki, msg, p1363ToDer(p1363))).toBe(true);
  });

  it('verifies a signature supplied in P1363 form', async () => {
    const { pair, spki } = await freshKey();
    const p1363 = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, msg),
    );
    expect(await subtleP256Verify(spki, msg, p1363)).toBe(true);
  });

  it('rejects a signature over a different message', async () => {
    const { pair, spki } = await freshKey();
    const p1363 = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, msg),
    );
    const other = new TextEncoder().encode('different');
    expect(await subtleP256Verify(spki, other, p1363ToDer(p1363))).toBe(false);
  });

  it('throws on a non-SEQUENCE DER', () => {
    expect(() => derToP1363(new Uint8Array([0x02, 0x01, 0x00]))).toThrow(/SEQUENCE/);
  });

  it('throws on trailing garbage after the SEQUENCE', () => {
    const der = new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0xff]);
    expect(() => derToP1363(der)).toThrow();
  });

  it('subtleP256Verify returns false (no throw) on malformed signature bytes', async () => {
    const { spki } = await freshKey();
    expect(await subtleP256Verify(spki, msg, new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
