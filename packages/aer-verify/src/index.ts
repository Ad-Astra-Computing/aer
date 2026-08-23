// @adastracomputing/aer-verify - independent, dependency-free AER bundle verifier.
//
// Recompute the canonical hash, verify the Ed25519 signature against a pinned key
// set, and check the signing-key-id binding, in any Web Crypto runtime. The same
// audited code runs in the CLI (Node), the console (browser) and the API (Worker),
// and third parties can verify AER evidence without trusting aer.run.

export {
  canonicalize,
  canonicalBytes,
  canonicalHash,
  stripIntegrity,
} from './canonical.js';

export {
  hexToBytes,
  bytesToHex,
  base64ToBytes,
  bytesToBase64,
  utf8,
  timingSafeEqual,
  hexEqual,
} from './bytes.js';

export {
  signingKeyIdFromPublicKey,
  signingKeyIdFromPublicKeyHex,
  rawEd25519ToSpki,
  subtleEd25519Verify,
  type Ed25519Verify,
} from './keys.js';

export {
  ATTESTATION_TYPE,
  ATTESTATION_SCHEMA,
  paeBytes,
  verifyDsseEnvelope,
  decodeAttestation,
  type AttestationPayload,
  type DsseEnvelope,
  type DsseSignature,
} from './dsse.js';

export {
  REASONS,
  type ReasonCode,
  type PinnedKey,
  type AnchorStatus,
  type AnchorCheck,
  type VerifiedAer,
} from './result.js';

export {
  verifyAerBundle,
  type VerifyAerOptions,
} from './verify-aer.js';

// Rekor transparency-log evidence (Tier-1 phase 2): verify OFFLINE that an anchored
// AER is committed to a signed tree head, without trusting a live Rekor read.
export {
  hashLeaf,
  hashChildren,
  computeRootFromInclusionProof,
  verifyInclusionProof,
} from './rekor/merkle.js';

export { derToP1363, subtleP256Verify } from './rekor/ecdsa.js';

export {
  parseCheckpoint,
  verifyCheckpoint,
  keyHint,
  keyHintHex,
  type CheckpointNote,
  type CheckpointSignature,
  type CheckpointKey,
  type CheckpointVerifyResult,
} from './rekor/checkpoint.js';

export { leafHashFromUuid, treeShardFromUuid } from './rekor/entry.js';

// Full offline anchor binding (Tier-1 phase 3): bind the proven leaf all the way back
// to the bundle (leaf ↔ body ↔ envelope ↔ attestation), so `anchored` can be true.
export {
  verifyAnchoredEvidence,
  ANCHOR_REASONS,
  type AnchorReason,
  type AnchorEvidence,
  type AnchorBindingResult,
  type AnchorBindingOptions,
  type BundleIdentity,
} from './rekor/anchor-binding.js';

export {
  verifyRekorEvidence,
  REKOR_REASONS,
  type RekorReason,
  type InclusionProof,
  type TransparencyAnchor,
  type RekorEvidenceResult,
  type RekorVerifyOptions,
} from './rekor/evidence.js';

// Trust root: the pinned key set (AER signing keys + transparency-log keys) a
// verifier trusts, independent of aer.run.
export {
  REKOR_SIGSTORE_V1_SPKI_B64,
  REKOR_SIGSTORE_V1_NAME,
  rekorSigstoreV1,
} from './trust/rekor-log.js';

export {
  builtinTrustRoot,
  loadTrustRoot,
  type TrustRoot,
  type LoadTrustRootOptions,
} from './trust/trust-root.js';

export { aerSigningKeys, AER_SIGSTORE_PROD_V1 } from './trust/aer-keys.js';
