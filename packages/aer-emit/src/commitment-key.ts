// Commitment-key primitives shared by aer-hooks (effects recording, P0-2).
// aer-auto-node keeps its own copy (zero-dep by design); aer-hooks already
// depends on this package, so this is the one real shared spot. File digests
// (aer-file-digest.v1) are a separate HMAC domain from aer-canon.v1 prompt
// tags, and there is no bare-SHA-256 fallback for a missing key: see
// aer-auto-node/src/commitment.ts's header for why.

import { createHash, createHmac } from 'node:crypto';

/** Minimum accepted commitment-key length. 32 bytes = 256-bit HMAC key. */
const MIN_KEY_BYTES = 32;

/**
 * Parse a commitment key from its string form (env AER_COMMITMENT_KEY).
 * Accepts 64-hex or base64/base64url; requires >= 32 decoded bytes. Returns
 * null on anything shorter or unparseable; the caller treats null as
 * "feature off". Decoding is strict: Node's hex/base64 decoders silently
 * drop invalid characters, so a malformed key must never be silently
 * accepted as a (shorter, weaker) key: that would quietly degrade every
 * digest to no_key without saying so.
 */
export function commitmentKeyFromString(s: string | undefined | null): Buffer | null {
  if (typeof s !== 'string' || s.length === 0) return null;
  let buf: Buffer | null = null;
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) {
    buf = Buffer.from(s, 'hex');
  } else if (/^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length % 4 === 0) {
    buf = Buffer.from(s, 'base64');
  } else if (/^[A-Za-z0-9_-]+$/.test(s)) {
    buf = Buffer.from(s, 'base64url');
  }
  if (!buf || buf.length < MIN_KEY_BYTES) return null;
  return buf;
}

/**
 * kid: a non-secret identifier of which commitment key produced a tag, so
 * a verifier knows which key to use and rotation is possible. Domain
 * separated ("aer-kid.v1") so a kid can never collide with any other place
 * the key might be hashed. Must derive the SAME kid as
 * aer-auto-node's deriveKid for the same key, so one key configured for
 * both collectors in one environment produces one kid either way. Do not
 * change this domain tag independently of that copy.
 */
export function deriveKid(key: Buffer): string {
  return createHash('sha256').update('aer-kid.v1').update(key).digest('hex').slice(0, 16);
}

/** Domain-separation prefix for a file-content digest. The fixed-length
 *  ASCII prefix plus a NUL separator needs no canonicalization, streams (a
 *  large file is never fully buffered to build the preimage), and cannot
 *  collide with any aer-canon.v1/aer-wire.v1 preimage (those all begin with
 *  `{`). This is the one byte layout that cannot change once shipped
 *  without breaking every verifier that recomputes it. */
export const FILE_DIGEST_DOMAIN = 'aer-file-digest.v1';
const FILE_DIGEST_PREFIX = Buffer.concat([Buffer.from(FILE_DIGEST_DOMAIN, 'utf8'), Buffer.from([0x00])]);

/**
 * sha256_* = HMAC-SHA256(key, utf8("aer-file-digest.v1") || 0x00 || file_bytes),
 * hex-encoded. Streamed over an async-iterable byte source (a Node
 * ReadableStream, an fs.ReadStream, or any async generator of
 * Buffer/Uint8Array chunks) so a 10 MiB file is never fully buffered just to
 * compute the preimage. Returns the hex tag and the exact byte count read,
 * so the caller can report `bytes` from the same pass that produced the tag
 * rather than a separate stat.
 */
export async function hashFileDigest(
  key: Buffer,
  chunks: AsyncIterable<Uint8Array>,
): Promise<{ hex: string; bytes: number }> {
  const hmac = createHmac('sha256', key);
  hmac.update(FILE_DIGEST_PREFIX);
  let bytes = 0;
  for await (const chunk of chunks) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buf.length;
    hmac.update(buf);
  }
  return { hex: hmac.digest('hex'), bytes };
}

/** Non-streamed convenience wrapper, for test vectors and small in-memory
 *  buffers only. Real file reads should use hashFileDigest with a stream. */
export function hashFileDigestSync(key: Buffer, data: Uint8Array): { hex: string; bytes: number } {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hex = createHmac('sha256', key).update(FILE_DIGEST_PREFIX).update(buf).digest('hex');
  return { hex, bytes: buf.length };
}
