// json-c14n-v1 — deterministic JSON canonicalization for AER verification.
//
// This is a byte-for-byte port of `@aer/schemas`'s canonicalize, with node:crypto
// removed so it runs in any Web Crypto runtime. A cross-package golden test
// (canonical.parity.test.ts) asserts this produces identical bytes to the schemas
// implementation on a battery of inputs, so the two copies cannot silently drift.
//
// Rules:
//   - UTF-8 output
//   - object keys sorted by UTF-16 code unit at every depth (JS default sort),
//     which equals RFC 8785 (JCS) for the BMP; AER schemas never emit astral keys
//   - arrays preserve insertion order (semantic)
//   - explicit null retained
//   - rejects: undefined, NaN, +/-Infinity, bigint, function, symbol, Date, Map, Set

import { bytesToHex, utf8 } from './bytes.js';

export function canonicalize(value: unknown): string {
  return stringify(value);
}

export function canonicalBytes(value: unknown): Uint8Array {
  return utf8(canonicalize(value));
}

/** Async because the only hash primitive available everywhere is crypto.subtle. */
export async function canonicalHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', canonicalBytes(value) as unknown as ArrayBuffer);
  return bytesToHex(new Uint8Array(digest));
}

function stringify(value: unknown): string {
  if (value === null) return 'null';

  const t = typeof value;

  if (t === 'string') return JSON.stringify(value);

  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new TypeError('canonicalize: non-finite number (NaN/Infinity) is not JSON-safe');
    }
    return JSON.stringify(value);
  }

  if (t === 'boolean') return (value as boolean) ? 'true' : 'false';

  if (t === 'undefined') {
    throw new TypeError('canonicalize: undefined is not permitted (would produce non-deterministic bytes)');
  }

  if (t === 'bigint') {
    throw new TypeError('canonicalize: bigint is not JSON-representable');
  }

  if (t === 'function' || t === 'symbol') {
    throw new TypeError(`canonicalize: ${t} is not JSON-representable`);
  }

  if (Array.isArray(value)) {
    return '[' + value.map(stringify).join(',') + ']';
  }

  if (t === 'object') {
    if (value instanceof Date || value instanceof Map || value instanceof Set) {
      throw new TypeError(`canonicalize: ${value.constructor.name} must be projected to JSON primitives by the caller`);
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      parts.push(JSON.stringify(k) + ':' + stringify(obj[k]));
    }
    return '{' + parts.join(',') + '}';
  }

  throw new TypeError(`canonicalize: unsupported value of type ${t}`);
}

/** Remove the integrity block before hashing (matches @aer/schemas.stripIntegrity). */
export function stripIntegrity<T extends Record<string, unknown>>(bundle: T): Omit<T, 'integrity'> {
  const copy: Record<string, unknown> = { ...bundle };
  delete copy['integrity'];
  return copy as Omit<T, 'integrity'>;
}
