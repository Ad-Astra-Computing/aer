import { createHash } from 'node:crypto';

/**
 * json-c14n-v1 — deterministic JSON canonicalization for AER signing.
 *
 * Rules:
 *   - UTF-8 output
 *   - object keys sorted by UTF-16 code unit at every depth — JS default String
 *     comparison (`Array.prototype.sort` with no comparator), which is also what
 *     RFC 8785 (JCS) specifies. This equals Unicode code-point order for the BMP;
 *     it only diverges for astral-plane keys, which AER schemas never emit.
 *   - arrays preserve insertion order (semantic)
 *   - explicit null retained
 *   - rejects: undefined, NaN, ±Infinity, bigint, functions, symbols, Date, Map, Set
 *     (all must be projected to strings/numbers by the caller before canonicalizing)
 */
export function canonicalize(value: unknown): string {
  return stringify(value);
}

export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalize(value), 'utf8');
}

export function canonicalHash(value: unknown, alg: 'sha256' = 'sha256'): string {
  return createHash(alg).update(canonicalBytes(value)).digest('hex');
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
