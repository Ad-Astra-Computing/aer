// Result shape + frozen reason codes for the verifier core. The reason codes are a
// stable API: downstream tooling matches on them, so add new ones rather than
// renaming existing ones.

export const REASONS = {
  BUNDLE_MISSING_INTEGRITY: 'bundle_missing_integrity',
  // The bundle could not be canonicalized (depth, non-finite number, bigint, Date,
  // or another non-JSON-safe shape). Reported as a normal failed verdict, never
  // an uncaught exception, since the bundle is attacker-controlled input.
  CANONICALIZE_ERROR: 'canonicalize_error',
  HASH_MISMATCH: 'hash_mismatch',
  SIGNATURE_INVALID: 'signature_invalid',
  SIGNATURE_ERROR: 'signature_error',
  KEY_ID_BINDING_MISMATCH: 'key_id_binding_mismatch',
  KEY_NOT_PINNED: 'key_not_pinned',
  KEY_PIN_EXPIRED: 'key_pin_expired',
  // Anchor (transparency) reasons. Full Rekor verification lands in Phase 2; until
  // then anchor evidence is reported as unverified, never silently trusted.
  ANCHOR_ABSENT: 'anchor_absent',
  ANCHOR_CLAIM_DOWNGRADED: 'anchor_claim_downgraded',
  ANCHOR_VERIFICATION_UNAVAILABLE: 'anchor_verification_unavailable',
  // Anchor evidence was supplied but the full offline chain (inclusion + checkpoint +
  // body↔leaf↔envelope↔bundle) did not verify. Distinct from UNAVAILABLE (no evidence).
  ANCHOR_EVIDENCE_INVALID: 'anchor_evidence_invalid',
  ANCHOR_REQUIRED_BY_POLICY: 'anchor_required_by_policy',
} as const;

export type ReasonCode = (typeof REASONS)[keyof typeof REASONS];

/** A platform signing key pinned out-of-band (from the trust root in Phase 2). */
export interface PinnedKey {
  signing_key_id: string;
  public_key_hex: string;
  status?: 'active' | 'retired';
  /** ISO instant after which this key must not sign NEW bundles (retired keys
   *  still verify bundles generated before this). */
  not_after?: string;
}

// Four-state anchor result:
//   verified - the full offline A-D chain passed (cryptographically anchored).
//   claimed  - the bundle claims anchoring but the evidence is legitimately
//              INCOMPLETE (absent, no stored body yet, or the signing key is not
//              pinned so we cannot confirm). NOT a defect: a self-attested claim we
//              could not independently verify. Does not downgrade the overall verdict
//              unless the caller requires anchoring.
//   invalid  - evidence is present but a cryptographic/structural check FAILS
//              (bad proof, malformed body, leaf/envelope/attestation mismatch, sig
//              invalid). A genuine contradiction - downgrades the overall verdict.
//   none     - no claim and no evidence.
export type AnchorStatus = 'verified' | 'claimed' | 'invalid' | 'none';

export interface AnchorCheck {
  status: AnchorStatus;
  /** What the bundle's UNSIGNED integrity.anchored field claimed, for display only. */
  claim: boolean | null;
  /** False when the bundle claims anchored:true but status !== 'verified'. */
  claim_consistent: boolean;
}

export interface VerifiedAer {
  /** Policy-evaluated verdict. */
  ok: boolean;
  aer_id: string;
  /** Recomputed locally, never echoed from the bundle. */
  canonical_hash: string;
  signing_key_id: string;
  /** True only when the anchor is cryptographically verified (Phase 2). */
  anchored: boolean;
  checks: {
    hash_match: boolean;
    signature_valid: boolean;
    /** sha256(pubkey)[:16] === signing_key_id. */
    key_id_binding: boolean;
    /** Key found in the pinned set within its validity window. */
    key_pinned: boolean;
    anchor: AnchorCheck;
  };
  reasons: ReasonCode[];
}
