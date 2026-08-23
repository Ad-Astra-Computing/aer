// Rekor checkpoint (signed tree head) parse + verify.
//
// A checkpoint is a Sigstore/Go-sumdb "signed note": text lines, a blank line, then
// one or more signature lines `- <name> <base64(keyHint4 || signature)>`. The signed
// bytes are the text portion up to and including the blank-line separator's first
// newline. For a Rekor log the text is:
//   line 0: origin, e.g. "rekor.sigstore.dev - <treeId>"
//   line 1: tree size (decimal)
//   line 2: base64(root hash)
//   line 3+: optional other content (ignored here)
//
// The checkpoint is the offline trust anchor for an anchored AER: it commits, under
// the log's own key, to the (treeSize, rootHash) that an inclusion proof recomputes.

import { base64ToBytes, bytesToHex, timingSafeEqual } from '../bytes.js';
import { subtleP256Verify } from './ecdsa.js';
import type { Ed25519Verify } from '../keys.js';

export interface CheckpointNote {
  /** Full first line, e.g. "rekor.sigstore.dev - 1193050959916656506". */
  origin: string;
  /** Tree size the checkpoint commits to. */
  treeSize: number;
  /** Root hash bytes (decoded from the base64 line). */
  rootHash: Uint8Array;
  /** Exact bytes covered by the signatures (the text incl. trailing newline). */
  signedBody: Uint8Array;
  signatures: CheckpointSignature[];
}

export interface CheckpointSignature {
  name: string;
  /** 4-byte key hint (first 4 bytes of SHA-256 over the signer's SPKI key). */
  keyHint: Uint8Array;
  /** Signature bytes: DER ECDSA for a P-256 log, raw 64 for an Ed25519 note key. */
  signature: Uint8Array;
}

/** A pinned checkpoint-signing key from the trust root. */
export interface CheckpointKey {
  /** Signer name that must match the note signature line (e.g. "rekor.sigstore.dev"). */
  name: string;
  /** SPKI DER public key. */
  spki: Uint8Array;
  algorithm: 'ecdsa-p256' | 'ed25519';
}

const encoder = new TextEncoder();

/** Parse a checkpoint note. Throws on a structurally invalid note. */
export function parseCheckpoint(note: string): CheckpointNote {
  const sep = note.indexOf('\n\n');
  if (sep < 0) throw new Error('checkpoint: missing text/signature separator');
  const signedBody = encoder.encode(note.slice(0, sep + 1));
  const textLines = note.slice(0, sep).split('\n');
  if (textLines.length < 3) throw new Error('checkpoint: too few header lines');

  const origin = textLines[0]!;
  const treeSize = Number(textLines[1]);
  if (!Number.isInteger(treeSize) || treeSize < 0) {
    throw new Error('checkpoint: invalid tree size');
  }
  const rootHash = base64ToBytes(textLines[2]!);

  const signatures: CheckpointSignature[] = [];
  for (const line of note.slice(sep + 2).split('\n')) {
    if (!line.startsWith('— ')) continue; // "— "
    const m = line.match(/^— (\S+) (\S+)$/);
    if (!m) throw new Error('checkpoint: malformed signature line');
    const raw = base64ToBytes(m[2]!);
    if (raw.length < 5) throw new Error('checkpoint: signature too short');
    signatures.push({ name: m[1]!, keyHint: raw.subarray(0, 4), signature: raw.subarray(4) });
  }
  if (signatures.length === 0) throw new Error('checkpoint: no signatures');
  return { origin, treeSize, rootHash, signedBody, signatures };
}

export interface CheckpointVerifyResult {
  valid: boolean;
  treeSize: number;
  rootHash: Uint8Array;
  origin: string;
  /** Name of the key whose signature verified, when valid. */
  signedBy?: string;
}

/**
 * Verify a checkpoint note against a set of pinned keys. Returns valid=true iff at
 * least one signature line is produced by a pinned key over the note body. The
 * key-hint must match (first 4 bytes of SHA-256 over the SPKI) before the (more
 * expensive) cryptographic check runs. Never throws on a bad signature - a parse
 * failure returns valid=false with the note left unparsed.
 *
 * `ed25519Verify` is injected so a runtime without native Ed25519 subtle support
 * (older Safari) can supply a fallback; it is only consulted for ed25519 keys.
 */
export async function verifyCheckpoint(
  note: string,
  keys: CheckpointKey[],
  ed25519Verify?: Ed25519Verify,
): Promise<CheckpointVerifyResult> {
  let parsed: CheckpointNote;
  try {
    parsed = parseCheckpoint(note);
  } catch {
    return { valid: false, treeSize: 0, rootHash: new Uint8Array(), origin: '' };
  }

  const base = {
    treeSize: parsed.treeSize,
    rootHash: parsed.rootHash,
    origin: parsed.origin,
  };

  for (const key of keys) {
    const hint = await keyHint(key.spki);
    for (const sig of parsed.signatures) {
      if (sig.name !== key.name) continue;
      if (!timingSafeEqual(hint, sig.keyHint)) continue;
      let ok = false;
      if (key.algorithm === 'ecdsa-p256') {
        ok = await subtleP256Verify(key.spki, parsed.signedBody, sig.signature);
      } else if (key.algorithm === 'ed25519' && ed25519Verify) {
        // An Ed25519 note key is stored raw (32 bytes) inside the SPKI; the verify
        // seam takes the raw key, so strip the 12-byte RFC 8410 SPKI prefix.
        const raw = key.spki.length === 44 ? key.spki.subarray(12) : key.spki;
        ok = await ed25519Verify(raw, parsed.signedBody, sig.signature);
      }
      if (ok) return { valid: true, ...base, signedBy: key.name };
    }
  }
  return { valid: false, ...base };
}

/** First 4 bytes of SHA-256 over the SPKI key: the note-format key hint. */
export async function keyHint(spki: Uint8Array): Promise<Uint8Array> {
  const d = await crypto.subtle.digest('SHA-256', spki as unknown as ArrayBuffer);
  return new Uint8Array(d).subarray(0, 4);
}

/** Hex of the 4-byte key hint, for diagnostics / trust-root authoring. */
export async function keyHintHex(spki: Uint8Array): Promise<string> {
  return bytesToHex(await keyHint(spki));
}
