// verifyAerBundle - the shared, origin-independent bundle verifier.
//
// Phase 1 scope: recompute the canonical hash, verify the Ed25519 signature over
// the hash bytes, assert the signing-key-id binds to the public key, and (when a
// pinned key set is supplied) assert the key is one AER actually published. The
// transparency-anchor verification (Rekor SET + inclusion proof against a pinned
// log key) lands in Phase 2; until then the anchor is reported as unverified and
// `anchored` is never true, so no verifier over-claims.

import { canonicalHash, stripIntegrity } from './canonical.js';
import { hexEqual, hexToBytes, base64ToBytes } from './bytes.js';
import { signingKeyIdFromPublicKeyHex, subtleEd25519Verify, type Ed25519Verify } from './keys.js';
import { REASONS, type PinnedKey, type ReasonCode, type AnchorStatus, type VerifiedAer } from './result.js';
import { verifyAnchoredEvidence, ANCHOR_REASONS, type AnchorEvidence } from './rekor/anchor-binding.js';
import type { CheckpointKey } from './rekor/checkpoint.js';

interface BundleIntegrity {
  hash: string;
  signature: string;
  signing_key_id: string;
  anchored?: boolean;
}

export interface VerifyAerOptions {
  /** Platform keys pinned out-of-band (from the trust root in Phase 2). When set,
   *  the bundle's key must be one of these unless requirePinnedKey is false. */
  pinnedKeys?: PinnedKey[];
  /** Fallback public key when the key is not pinned; surfaced with key_pinned:false. */
  publicKeyHex?: string;
  policy?: {
    /** Fail unless the key is in the pinned set. Defaults to true iff pinnedKeys given. */
    requirePinnedKey?: boolean;
    /** Fail unless the anchor is cryptographically verified. */
    requireAnchor?: boolean;
  };
  /** The stored transparency anchor (body + envelope + inclusion proof). When
   *  supplied with rekorLogs + a pinned AER key, the full offline chain is verified
   *  and `anchored` can become true. Omitted → anchor is never claimed verified. */
  anchorEvidence?: AnchorEvidence;
  /** Set when the caller's anchor-evidence source returned a ref that is PRESENT but
   *  corrupt (unparseable / oversized / structurally invalid crypto field) rather than
   *  absent. This is a real failure: the anchor is forced to `invalid` (which downgrades
   *  the overall verdict), never allowed to soften to `claimed`. Distinct from a merely
   *  incomplete anchor (missing body pre-backfill), which stays `claimed`. */
  anchorEvidenceMalformed?: boolean;
  /** Pinned transparency-log (Rekor) keys for the checkpoint signature. */
  rekorLogs?: CheckpointKey[];
  /** Injectable Ed25519 verify for runtimes without native support (Safari < 17). */
  ed25519Verify?: Ed25519Verify;
}

function readIntegrity(bundle: Record<string, unknown>): BundleIntegrity | null {
  const i = bundle['integrity'];
  if (!i || typeof i !== 'object') return null;
  const r = i as Record<string, unknown>;
  if (typeof r['hash'] !== 'string' || typeof r['signature'] !== 'string' || typeof r['signing_key_id'] !== 'string') {
    return null;
  }
  return {
    hash: r['hash'],
    signature: r['signature'],
    signing_key_id: r['signing_key_id'],
    ...(typeof r['anchored'] === 'boolean' ? { anchored: r['anchored'] } : {}),
  };
}

export async function verifyAerBundle(
  bundle: Record<string, unknown>,
  opts: VerifyAerOptions = {},
): Promise<VerifiedAer> {
  const verify = opts.ed25519Verify ?? subtleEd25519Verify;
  const aerId = typeof bundle['aer_id'] === 'string' ? (bundle['aer_id'] as string) : '';
  const reasons: ReasonCode[] = [];

  const integrity = readIntegrity(bundle);
  if (!integrity) {
    return {
      ok: false,
      aer_id: aerId,
      canonical_hash: '',
      signing_key_id: '',
      anchored: false,
      checks: {
        hash_match: false,
        signature_valid: false,
        key_id_binding: false,
        key_pinned: false,
        anchor: { status: 'none', claim: null, claim_consistent: true },
      },
      reasons: [REASONS.BUNDLE_MISSING_INTEGRITY],
    };
  }

  // 1. Recompute the canonical hash (never trust integrity.hash for the compare).
  const recomputed = await canonicalHash(stripIntegrity(bundle));
  const hashMatch = hexEqual(recomputed, integrity.hash);
  if (!hashMatch) reasons.push(REASONS.HASH_MISMATCH);

  // 2. Resolve the public key: prefer the pinned set, fall back to the supplied key.
  const pinned = (opts.pinnedKeys ?? []).find((k) => k.signing_key_id.toLowerCase() === integrity.signing_key_id.toLowerCase());
  const keyPinned = pinned !== undefined;
  const publicKeyHex = pinned?.public_key_hex ?? opts.publicKeyHex;
  const requirePinnedKey = opts.policy?.requirePinnedKey ?? (opts.pinnedKeys !== undefined && opts.pinnedKeys.length > 0);
  if (requirePinnedKey && !keyPinned) reasons.push(REASONS.KEY_NOT_PINNED);

  // 3. Key-id binding + 4. signature - only meaningful once we have a key.
  let keyIdBinding = false;
  let signatureValid = false;
  if (publicKeyHex) {
    try {
      const derivedKid = await signingKeyIdFromPublicKeyHex(publicKeyHex);
      keyIdBinding = derivedKid === integrity.signing_key_id.toLowerCase();
    } catch {
      keyIdBinding = false;
    }
    if (!keyIdBinding) {
      reasons.push(REASONS.KEY_ID_BINDING_MISMATCH);
    } else {
      try {
        signatureValid = await verify(
          hexToBytes(publicKeyHex),
          hexToBytes(integrity.hash),
          base64ToBytes(integrity.signature),
        );
        if (!signatureValid) reasons.push(REASONS.SIGNATURE_INVALID);
      } catch {
        reasons.push(REASONS.SIGNATURE_ERROR);
      }
    }
  } else {
    // No key at all: cannot judge the signature. Surface it as not-pinned.
    if (!reasons.includes(REASONS.KEY_NOT_PINNED)) reasons.push(REASONS.KEY_NOT_PINNED);
  }

  // 5. Anchor. When the caller supplies the stored anchor evidence plus pinned Rekor
  //    log keys, verify the FULL offline chain (inclusion + checkpoint, then
  //    leaf↔body↔envelope↔attestation↔bundle) and set `anchored` from that. The
  //    attestation is bound to the LOCALLY-RECOMPUTED hash, never integrity.hash, so a
  //    tampered hash can't ride a genuine anchor. With no evidence we never claim an
  //    anchor verified (no over-claim), matching the pre-phase-3 behaviour.
  const claim = integrity.anchored ?? null;
  let anchored = false;
  let anchorStatus: AnchorStatus;
  if (opts.anchorEvidenceMalformed) {
    // Evidence exists but is corrupt: a hard failure that downgrades the verdict.
    // Never softened to `claimed` - that state is reserved for evidence that is
    // legitimately incomplete, not evidence that contradicts itself.
    anchorStatus = 'invalid';
    reasons.push(REASONS.ANCHOR_EVIDENCE_INVALID);
  } else if (opts.anchorEvidence) {
    // The anchor's DSSE signature MUST chain to a PINNED AER key - never the
    // caller-supplied fallback key. Otherwise an attacker who controls the bundle,
    // its served key, the DSSE envelope and a matching Rekor entry could self-verify
    // as anchored. No pinned key ⇒ empty set ⇒ verifyAnchoredEvidence returns
    // NO_AER_KEY and anchored stays false.
    const aerKeys = keyPinned && pinned ? [pinned] : [];
    const binding = await verifyAnchoredEvidence(
      opts.anchorEvidence,
      { aer_id: aerId, canonical_hash: recomputed, signing_key_id: integrity.signing_key_id },
      {
        rekorLogs: opts.rekorLogs ?? [],
        aerKeys,
        ...(opts.ed25519Verify ? { ed25519Verify: opts.ed25519Verify } : {}),
      },
    );
    anchored = binding.anchored;
    // Evidence present but the chain did not fully verify. Distinguish a
    // legitimately-INCOMPLETE anchor (claimed) from a genuine CONTRADICTION (invalid):
    // a missing stored body (pre-backfill) or an un-pinned signing key means we simply
    // cannot confirm - not that the record is bad. But `claimed` specifically
    // represents the bundle's OWN anchoring claim, so we only soften to it when the
    // signed integrity block actually asserts anchored:true. Evidence
    // that is unverifiable for one of these reasons on a bundle that does NOT claim
    // anchoring is anomalous and treated as invalid, as is every other failure (bad
    // inclusion proof, malformed/mismatched body, bad envelope sig, wrong attestation).
    const incomplete =
      binding.reasons.includes(ANCHOR_REASONS.NO_BODY) ||
      binding.reasons.includes(ANCHOR_REASONS.NO_AER_KEY);
    if (binding.anchored) {
      anchorStatus = 'verified';
    } else if (incomplete && claim === true) {
      anchorStatus = 'claimed';
      reasons.push(REASONS.ANCHOR_VERIFICATION_UNAVAILABLE);
    } else {
      anchorStatus = 'invalid';
      reasons.push(REASONS.ANCHOR_EVIDENCE_INVALID);
    }
  } else {
    anchorStatus = claim === true ? 'claimed' : 'none';
    if (claim === true) reasons.push(REASONS.ANCHOR_VERIFICATION_UNAVAILABLE);
  }
  // claim_consistent is false when the bundle claims anchored:true but we did not
  // verify it (status !== 'verified').
  const claimConsistent = !(claim === true && anchorStatus !== 'verified');
  const requireAnchor = opts.policy?.requireAnchor ?? false;
  if (requireAnchor && !anchored) reasons.push(REASONS.ANCHOR_REQUIRED_BY_POLICY);

  const ok =
    hashMatch &&
    signatureValid &&
    keyIdBinding &&
    (!requirePinnedKey || keyPinned) &&
    (!requireAnchor || anchored) &&
    // A present-but-CONTRADICTORY anchor downgrades the verdict even when anchoring
    // is not required; a merely-`claimed` (incomplete) one does not.
    anchorStatus !== 'invalid';

  return {
    ok,
    aer_id: aerId,
    canonical_hash: recomputed,
    signing_key_id: integrity.signing_key_id,
    anchored,
    checks: {
      hash_match: hashMatch,
      signature_valid: signatureValid,
      key_id_binding: keyIdBinding,
      key_pinned: keyPinned,
      anchor: { status: anchorStatus, claim, claim_consistent: claimConsistent },
    },
    reasons,
  };
}
