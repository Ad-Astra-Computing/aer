// ECDSA P-256 verification for Rekor evidence, Web-Crypto only.
//
// Rekor signs checkpoints (and SETs) with ECDSA P-256 / SHA-256 and ships the
// signature DER-encoded (ASN.1 SEQUENCE { INTEGER r, INTEGER s }). Web Crypto's
// subtle.verify wants the IEEE P1363 fixed-width r||s form, so we convert. The
// conversion is strict: a malformed DER structure throws rather than silently
// verifying, so a mangled signature can never pass as valid.

const P256_COORD_BYTES = 32;

/**
 * Convert a DER-encoded ECDSA signature to IEEE P1363 (r||s), each coordinate
 * left-padded to `coordBytes` (32 for P-256). Throws on any structural violation.
 */
export function derToP1363(der: Uint8Array, coordBytes = P256_COORD_BYTES): Uint8Array {
  let o = 0;
  if (der[o++] !== 0x30) throw new Error('ECDSA DER: expected SEQUENCE');
  let seqLen = der[o++]!;
  if (seqLen & 0x80) {
    // Long-form length: a valid P-256 signature is short-form, but accept 1-byte long-form.
    const n = seqLen & 0x7f;
    if (n !== 1) throw new Error('ECDSA DER: unsupported length encoding');
    seqLen = der[o++]!;
  }
  if (o + seqLen !== der.length) throw new Error('ECDSA DER: trailing bytes or bad length');

  const readInt = (): Uint8Array => {
    if (der[o++] !== 0x02) throw new Error('ECDSA DER: expected INTEGER');
    const len = der[o++]!;
    if (len === 0 || len & 0x80) throw new Error('ECDSA DER: bad INTEGER length');
    let v = der.subarray(o, o + len);
    o += len;
    // Strip a single leading 0x00 sign byte (DER pads to keep integers positive).
    if (v.length > 1 && v[0] === 0x00) v = v.subarray(1);
    if (v.length > coordBytes) throw new Error('ECDSA DER: INTEGER too large for curve');
    return v;
  };

  const r = readInt();
  const s = readInt();
  if (o !== der.length) throw new Error('ECDSA DER: unconsumed bytes');

  const out = new Uint8Array(coordBytes * 2);
  out.set(r, coordBytes - r.length);
  out.set(s, coordBytes * 2 - s.length);
  return out;
}

/**
 * Verify an ECDSA P-256 / SHA-256 signature over `message` with an SPKI public key.
 * `signature` may be DER (Rekor wire form) or already P1363 (64 bytes). Returns a
 * boolean; never throws - a malformed key or signature is a failed verification.
 */
export async function subtleP256Verify(
  spkiPublicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    const sig = signature.length === P256_COORD_BYTES * 2 ? signature : derToP1363(signature);
    const key = await crypto.subtle.importKey(
      'spki',
      spkiPublicKey as unknown as ArrayBuffer,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      sig as unknown as ArrayBuffer,
      message as unknown as ArrayBuffer,
    );
  } catch {
    return false;
  }
}
