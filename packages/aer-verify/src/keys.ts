// Ed25519 key handling for the verifier core. Web Crypto only, with an injectable
// verify seam so runtimes without native Ed25519 (Safari < 17) can supply a
// fallback (e.g. @noble/ed25519) WITHOUT this package taking a dependency.

import { bytesToHex, hexToBytes } from './bytes.js';

// Fixed 12-byte ASN.1 SPKI prefix for a raw Ed25519 public key (RFC 8410).
const ED25519_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

/**
 * Derive the AER signing-key-id from a raw Ed25519 public key: the first 16 hex
 * chars of SHA-256 over the raw 32 key bytes. MUST match
 * the server generator's signingKeyIdFromPublicKey exactly, or the
 * key-id binding check would false-reject every genuine bundle.
 */
export async function signingKeyIdFromPublicKey(publicKeyRaw: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', publicKeyRaw as unknown as ArrayBuffer);
  return bytesToHex(new Uint8Array(digest)).slice(0, 16);
}

/** Convenience wrapper taking a hex-encoded raw public key. */
export async function signingKeyIdFromPublicKeyHex(publicKeyHex: string): Promise<string> {
  return signingKeyIdFromPublicKey(hexToBytes(publicKeyHex));
}

/** Wrap a raw 32-byte Ed25519 public key in SPKI DER for crypto.subtle.importKey. */
export function rawEd25519ToSpki(raw32: Uint8Array): Uint8Array {
  if (raw32.length !== 32) throw new Error(`expected 32-byte Ed25519 key, got ${raw32.length}`);
  const der = new Uint8Array(ED25519_SPKI_PREFIX.length + 32);
  der.set(ED25519_SPKI_PREFIX, 0);
  der.set(raw32, ED25519_SPKI_PREFIX.length);
  return der;
}

/** An injectable Ed25519 verifier: (publicKeyRaw, message, signature) => valid. */
export type Ed25519Verify = (
  publicKeyRaw: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
) => Promise<boolean>;

/**
 * Default Ed25519 verify using crypto.subtle. Available natively in Node >= 20,
 * Cloudflare Workers and modern browsers. On a runtime without native Ed25519
 * (older Safari) importKey throws; callers should inject a fallback via the
 * `ed25519Verify` option instead of this default.
 */
export const subtleEd25519Verify: Ed25519Verify = async (publicKeyRaw, message, signature) => {
  const key = await crypto.subtle.importKey(
    'spki',
    rawEd25519ToSpki(publicKeyRaw) as unknown as ArrayBuffer,
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    'Ed25519',
    key,
    signature as unknown as ArrayBuffer,
    message as unknown as ArrayBuffer,
  );
};
