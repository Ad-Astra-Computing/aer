// AER trust root - the set of keys a verifier pins to check AER evidence without
// trusting aer.run at verification time: the platform AER signing keys (for the
// bundle Ed25519 signature) and the transparency-log keys (for anchor checkpoints).
//
// The builtin root ships with the public Rekor log key baked in and an empty AER
// signing-key set (those are fetched/pinned per deployment). A future SIGNED trust
// root - the owner's offline root key over this document, with rotation + expiry -
// lets third parties pin a single root and trust delegated keys transitively; that
// signing step is owner-gated, so `loadTrustRoot` already models version/expiry and
// an optional signature envelope so the format is stable before the key exists.

import { base64ToBytes } from '../bytes.js';
import type { PinnedKey } from '../result.js';
import type { CheckpointKey } from '../rekor/checkpoint.js';
import { rekorSigstoreV1 } from './rekor-log.js';
import { aerSigningKeys } from './aer-keys.js';

export interface TrustRoot {
  /** Monotonic version; a newer root supersedes an older one. */
  version: number;
  /** Platform AER signing keys (Ed25519) trusted to sign bundles. */
  aerSigningKeys: PinnedKey[];
  /** Transparency-log keys trusted to sign anchor checkpoints. */
  rekorLogs: CheckpointKey[];
  /** ISO 8601 expiry; a verifier rejects an expired root. Omitted = no expiry. */
  expiresAt?: string;
}

/** The builtin trust root: the pinned public Rekor v1 log key + pinned platform
 *  AER signing keys, so a verifier can check the full offline anchor chain without
 *  fetching any key from aer.run at verification time. */
export function builtinTrustRoot(): TrustRoot {
  return {
    version: 2,
    aerSigningKeys: aerSigningKeys(),
    rekorLogs: [rekorSigstoreV1()],
  };
}

export interface LoadTrustRootOptions {
  /** Current time (ms epoch) for the expiry check; injectable for tests. */
  now?: number;
}

/**
 * Parse + validate a serialized trust root. The wire form encodes key material as
 * base64 (public_key_hex stays hex for AER keys, matching the bundle key-id math).
 * Throws on a malformed document or an expired root, so a caller can trust the
 * returned keys unconditionally.
 */
export function loadTrustRoot(doc: unknown, opts: LoadTrustRootOptions = {}): TrustRoot {
  if (!doc || typeof doc !== 'object') throw new Error('trust root: not an object');
  const d = doc as Record<string, unknown>;

  const version = d['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new Error('trust root: invalid version');
  }

  const expiresAt = typeof d['expiresAt'] === 'string' ? d['expiresAt'] : undefined;
  if (expiresAt !== undefined) {
    const exp = Date.parse(expiresAt);
    if (Number.isNaN(exp)) throw new Error('trust root: invalid expiresAt');
    const now = opts.now ?? nowMs();
    if (now > exp) throw new Error('trust root: expired');
  }

  const aerSigningKeys = parseAerKeys(d['aerSigningKeys']);
  const rekorLogs = parseRekorLogs(d['rekorLogs']);

  return { version, aerSigningKeys, rekorLogs, ...(expiresAt ? { expiresAt } : {}) };
}

function parseAerKeys(v: unknown): PinnedKey[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error('trust root: aerSigningKeys must be an array');
  return v.map((raw, i) => {
    const k = raw as Record<string, unknown>;
    if (typeof k?.['signing_key_id'] !== 'string' || typeof k?.['public_key_hex'] !== 'string') {
      throw new Error(`trust root: aerSigningKeys[${i}] malformed`);
    }
    return { signing_key_id: k['signing_key_id'], public_key_hex: k['public_key_hex'] };
  });
}

function parseRekorLogs(v: unknown): CheckpointKey[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error('trust root: rekorLogs must be an array');
  return v.map((raw, i) => {
    const k = raw as Record<string, unknown>;
    const name = k?.['name'];
    const spkiB64 = k?.['spki_b64'];
    const algorithm = k?.['algorithm'];
    if (typeof name !== 'string' || typeof spkiB64 !== 'string') {
      throw new Error(`trust root: rekorLogs[${i}] malformed`);
    }
    if (algorithm !== 'ecdsa-p256' && algorithm !== 'ed25519') {
      throw new Error(`trust root: rekorLogs[${i}] unsupported algorithm`);
    }
    return { name, spki: base64ToBytes(spkiB64), algorithm };
  });
}

function nowMs(): number {
  // Date.now via an indirection so the module stays pure-importable in test harnesses
  // that stub time; callers should pass opts.now in deterministic contexts.
  return Date.now();
}
