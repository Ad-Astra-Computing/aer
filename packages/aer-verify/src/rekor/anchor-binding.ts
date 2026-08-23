// Full offline anchor binding (Tier-1 phase 3).
//
// verifyRekorEvidence (phase 2) proves one thing: a leaf hash is committed to by a
// Rekor-signed tree head. That is necessary but NOT sufficient to claim "THIS AER is
// anchored" - the leaf is an opaque 32 bytes until we bind it, offline, all the way
// back to the bundle. This module closes that chain:
//
//   A. inclusion + checkpoint            leaf ∈ signed tree head   (verifyRekorEvidence)
//   B. leaf == SHA256(0x00 || body)      the persisted Rekor body IS the proven leaf
//   C. body.spec ↔ DSSE envelope         Rekor witnessed THIS envelope (payload hash + sig)
//   D. envelope ↔ bundle                 DSSE sig verifies under a pinned AER key AND
//                                        the attestation commits to this aer_id + hash
//
// Only when A∧B∧C∧D hold is `anchored` true. Any missing/mismatching link leaves the
// AER UNANCHORED; we never partially upgrade. The Rekor `body` is
// the leaf PREIMAGE and must be the exact bytes Rekor canonicalized; we recompute the
// leaf from it rather than trusting any reconstructed JSON.
//
// integratedTime is deliberately NOT authenticated here: it is not covered by the
// inclusion proof, and we do not verify the SET. Callers must not present it as a
// cryptographically verified timestamp.

import { sha256, hashLeaf } from './merkle.js';
import { leafHashFromUuid } from './entry.js';
import { verifyRekorEvidence, type TransparencyAnchor, type RekorEvidenceResult } from './evidence.js';
import type { CheckpointKey } from './checkpoint.js';
import {
  verifyDsseEnvelope,
  decodeAttestation,
  type DsseEnvelope,
} from '../dsse.js';
import { base64ToBytes, bytesToHex, hexEqual, hexToBytes, timingSafeEqual } from '../bytes.js';
import { subtleEd25519Verify, type Ed25519Verify } from '../keys.js';
import type { PinnedKey } from '../result.js';

// Rekor dsse:0.0.1 bodies are a few hundred bytes (two hashes, one signature, one
// PEM verifier). A generous ceiling caps the leaf-preimage hash work and rejects a
// pathological stored body outright.
const MAX_REKOR_BODY_BYTES = 16 * 1024;

/** A stored anchor carrying the persisted Rekor body + DSSE envelope (phase 3). */
export interface AnchorEvidence extends TransparencyAnchor {
  /** base64 of the EXACT Rekor entry body bytes — the RFC 6962 leaf preimage. */
  body?: string;
  /** The DSSE envelope we submitted (attestation over the AER identity). */
  envelope?: DsseEnvelope;
}

/** The bundle identity the anchor must commit to (all lower/upper handled by hexEqual). */
export interface BundleIdentity {
  aer_id: string;
  /** integrity.hash — the canonical hash the attestation must carry. */
  canonical_hash: string;
  signing_key_id: string;
}

export const ANCHOR_REASONS = {
  OK: 'anchor_fully_verified',
  REKOR_UNVERIFIED: 'anchor_rekor_evidence_unverified',
  NO_BODY: 'anchor_missing_rekor_body',
  BODY_TOO_LARGE: 'anchor_rekor_body_too_large',
  BODY_MALFORMED: 'anchor_rekor_body_malformed',
  BODY_LEAF_MISMATCH: 'anchor_body_not_the_proven_leaf',
  NO_ENVELOPE: 'anchor_missing_envelope',
  BODY_ENVELOPE_MISMATCH: 'anchor_body_does_not_bind_envelope',
  NO_AER_KEY: 'anchor_no_pinned_aer_key',
  ENVELOPE_SIG_INVALID: 'anchor_envelope_signature_invalid',
  ATTESTATION_MISMATCH: 'anchor_attestation_disagrees_with_bundle',
} as const;

export type AnchorReason = (typeof ANCHOR_REASONS)[keyof typeof ANCHOR_REASONS];

export interface AnchorBindingResult {
  /** True iff the WHOLE chain A∧B∧C∧D holds. Never a partial upgrade. */
  anchored: boolean;
  /** Phase-2 rekor evidence result (inclusion + checkpoint), for surfacing detail. */
  rekor: RekorEvidenceResult;
  /** body == leaf preimage of the proven leaf. */
  bodyBindsLeaf: boolean;
  /** Rekor body commits to the envelope's payload hash + signature. */
  bodyBindsEnvelope: boolean;
  /** DSSE envelope signature verifies under a pinned AER key. */
  envelopeSignatureValid: boolean;
  /** Attestation payload commits to this aer_id + canonical_hash + key. */
  attestationBindsBundle: boolean;
  reasons: AnchorReason[];
}

export interface AnchorBindingOptions {
  /** Pinned transparency-log keys (Rekor) for the checkpoint signature. */
  rekorLogs: CheckpointKey[];
  /** Pinned AER signing keys for the DSSE envelope + key-id match. */
  aerKeys: PinnedKey[];
  /** Ed25519 fallback for runtimes without native subtle Ed25519. */
  ed25519Verify?: Ed25519Verify;
}

interface RekorBodySpec {
  payloadHashHex: string;
  signatures: string[]; // base64 signatures, in order
}

/** True iff `v` is a hash object `{algorithm:'sha256', value:string}`; returns the value. */
function sha256HashValue(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const h = v as Record<string, unknown>;
  if (h['algorithm'] !== 'sha256') return null;
  return typeof h['value'] === 'string' ? h['value'] : null;
}

/**
 * Parse the fields of a Rekor dsse:0.0.1 body we bind against. Returns null unless the
 * body is EXACTLY the expected entry kind/version with sha256 hashes - a differently
 * typed Rekor leaf with a conveniently-shaped spec must not be read as AER evidence.
 */
function parseRekorBodySpec(bodyBytes: Uint8Array): RekorBodySpec | null {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r['kind'] !== 'dsse' || r['apiVersion'] !== '0.0.1') return null;
  const spec = r['spec'];
  if (!spec || typeof spec !== 'object') return null;
  const s = spec as Record<string, unknown>;
  // Require both hashes to be sha256; payloadHash carries the value we bind against.
  if (sha256HashValue(s['envelopeHash']) === null) return null;
  const phVal = sha256HashValue(s['payloadHash']);
  if (phVal === null) return null;
  const sigs = s['signatures'];
  if (!Array.isArray(sigs) || sigs.length === 0) return null;
  const signatures: string[] = [];
  for (const entry of sigs) {
    const sig = entry && typeof entry === 'object' ? (entry as Record<string, unknown>)['signature'] : undefined;
    if (typeof sig !== 'string') return null;
    signatures.push(sig);
  }
  return { payloadHashHex: phVal, signatures };
}

/**
 * Verify the full offline anchor chain for an AER. Never throws; a malformed or
 * incomplete anchor simply yields `anchored:false` with machine-readable reasons.
 */
export async function verifyAnchoredEvidence(
  anchor: AnchorEvidence,
  bundle: BundleIdentity,
  opts: AnchorBindingOptions,
): Promise<AnchorBindingResult> {
  const reasons: AnchorReason[] = [];
  const verify = opts.ed25519Verify ?? subtleEd25519Verify;
  const base: Omit<AnchorBindingResult, 'anchored' | 'rekor' | 'reasons'> = {
    bodyBindsLeaf: false,
    bodyBindsEnvelope: false,
    envelopeSignatureValid: false,
    attestationBindsBundle: false,
  };

  // A. Inclusion proof recomputes the checkpoint-signed root, signed by a pinned key.
  const rekor = await verifyRekorEvidence(anchor, {
    keys: opts.rekorLogs,
    ...(opts.ed25519Verify ? { ed25519Verify: opts.ed25519Verify } : {}),
  });
  const done = (extra: Partial<AnchorBindingResult>): AnchorBindingResult => ({
    ...base,
    ...extra,
    anchored: extra.anchored ?? false,
    rekor,
    reasons,
  });
  if (!rekor.verified) {
    reasons.push(ANCHOR_REASONS.REKOR_UNVERIFIED);
    return done({});
  }

  // B. The persisted Rekor body must be EXACTLY the proven leaf's preimage.
  if (typeof anchor.body !== 'string' || anchor.body.length === 0) {
    reasons.push(ANCHOR_REASONS.NO_BODY);
    return done({});
  }
  let bodyBytes: Uint8Array;
  try {
    bodyBytes = base64ToBytes(anchor.body);
  } catch {
    reasons.push(ANCHOR_REASONS.BODY_MALFORMED);
    return done({});
  }
  if (bodyBytes.length === 0 || bodyBytes.length > MAX_REKOR_BODY_BYTES) {
    reasons.push(ANCHOR_REASONS.BODY_TOO_LARGE);
    return done({});
  }
  let provenLeaf: Uint8Array;
  try {
    provenLeaf = leafHashFromUuid(anchor.uuid);
  } catch {
    // verifyRekorEvidence already validated the uuid, so this should not happen.
    reasons.push(ANCHOR_REASONS.BODY_LEAF_MISMATCH);
    return done({});
  }
  const bodyBindsLeaf = timingSafeEqual(await hashLeaf(bodyBytes), provenLeaf);
  if (!bodyBindsLeaf) {
    reasons.push(ANCHOR_REASONS.BODY_LEAF_MISMATCH);
    return done({});
  }

  // C. The Rekor body must commit to the envelope's payload hash + signatures.
  const spec = parseRekorBodySpec(bodyBytes);
  if (!spec) {
    reasons.push(ANCHOR_REASONS.BODY_MALFORMED);
    return done({ bodyBindsLeaf });
  }
  const envelope = anchor.envelope;
  if (!envelope || typeof envelope.payload !== 'string' || !Array.isArray(envelope.signatures)) {
    reasons.push(ANCHOR_REASONS.NO_ENVELOPE);
    return done({ bodyBindsLeaf });
  }
  let envelopePayloadHashHex: string;
  try {
    envelopePayloadHashHex = bytesToHex(await sha256(base64ToBytes(envelope.payload)));
  } catch {
    reasons.push(ANCHOR_REASONS.BODY_ENVELOPE_MISMATCH);
    return done({ bodyBindsLeaf });
  }
  const sigsMatch =
    spec.signatures.length === envelope.signatures.length &&
    spec.signatures.every((s, i) => s === envelope.signatures[i]?.sig);
  const bodyBindsEnvelope = hexEqual(spec.payloadHashHex, envelopePayloadHashHex) && sigsMatch;
  if (!bodyBindsEnvelope) {
    reasons.push(ANCHOR_REASONS.BODY_ENVELOPE_MISMATCH);
    return done({ bodyBindsLeaf });
  }

  // D. The envelope must bind to THIS bundle: DSSE sig under a pinned AER key whose
  //    id matches the bundle, and an attestation committing to aer_id + canonical_hash.
  const pinned = opts.aerKeys.find(
    (k) => k.signing_key_id.toLowerCase() === bundle.signing_key_id.toLowerCase(),
  );
  if (!pinned) {
    reasons.push(ANCHOR_REASONS.NO_AER_KEY);
    return done({ bodyBindsLeaf, bodyBindsEnvelope });
  }
  let envelopeSignatureValid = false;
  try {
    envelopeSignatureValid = await verifyDsseEnvelope(envelope, hexToBytes(pinned.public_key_hex), verify);
  } catch {
    envelopeSignatureValid = false;
  }
  if (!envelopeSignatureValid) {
    reasons.push(ANCHOR_REASONS.ENVELOPE_SIG_INVALID);
    return done({ bodyBindsLeaf, bodyBindsEnvelope });
  }
  const att = decodeAttestation(envelope);
  const attestationBindsBundle =
    !!att &&
    att.aer_id === bundle.aer_id &&
    hexEqual(att.canonical_hash, bundle.canonical_hash) &&
    att.signing_key_id.toLowerCase() === bundle.signing_key_id.toLowerCase();
  if (!attestationBindsBundle) {
    reasons.push(ANCHOR_REASONS.ATTESTATION_MISMATCH);
    return done({ bodyBindsLeaf, bodyBindsEnvelope, envelopeSignatureValid });
  }

  reasons.push(ANCHOR_REASONS.OK);
  return done({
    anchored: true,
    bodyBindsLeaf,
    bodyBindsEnvelope,
    envelopeSignatureValid,
    attestationBindsBundle,
  });
}
