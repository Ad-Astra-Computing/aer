// Byte and encoding helpers. No node:crypto, no Buffer — everything here runs
// unchanged in Node, Cloudflare Workers and browsers so the verifier core has a
// single audited implementation across all three.

/** Decode a hex string to bytes. Throws on odd length or non-hex characters. */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hexToBytes: odd-length hex string');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('hexToBytes: non-hex character');
    out[i] = byte;
  }
  return out;
}

/** Lower-case hex of a byte buffer. */
export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Decode standard OR url-safe base64 (with or without padding) to bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  const std = b64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = std + '='.repeat((4 - (std.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Standard base64 (padded) of a byte buffer. */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** UTF-8 encode. */
export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * Length-then-content comparison that does not short-circuit on the first
 * differing byte. Inputs here are hashes/signatures, not secrets, so this is
 * defence-in-depth rather than a strict requirement; it costs nothing.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Case-insensitive constant-ish comparison of two hex strings. */
export function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  let diff = 0;
  for (let i = 0; i < al.length; i++) diff |= al.charCodeAt(i) ^ bl.charCodeAt(i);
  return diff === 0;
}
