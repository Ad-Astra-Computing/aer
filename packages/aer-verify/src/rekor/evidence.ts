// Rekor evidence verifier - the offline trust anchor for an anchored AER.
//
// Given a stored transparency_anchor_ref, prove OFFLINE (no live Rekor read) that
// the entry is committed to a signed tree head:
//   1. Derive the leaf hash from the entry UUID.
//   2. Recompute the Merkle root from the inclusion proof (RFC 6962) and confirm it
//      equals the proof's stated rootHash.
//   3. Confirm the checkpoint commits to the SAME (treeSize, rootHash).
//   4. Verify the checkpoint signature with a pinned log key from the trust root.
// All four must hold. The result is a plain verdict with machine-readable reasons;
// it never throws, so a caller can treat a malformed anchor as simply unverified.
//
// The SET (signedEntryTimestamp) is intentionally NOT used: Rekor signs it over
// {body, integratedTime, logID, logIndex}, and we do not persist body/logID, so it
// is not offline-verifiable. The checkpoint (signed tree head) is a strictly
// stronger witness and IS fully offline-verifiable from the stored fields.
//
// What this DOES prove: the entry leaf is included in a Rekor-signed tree head, and
// (for sharded UUIDs) that leaf belongs to the checkpoint's own tree. What it does
// NOT prove: (a) global non-equivocation - a signed checkpoint attests one view of
// the log; ruling out a split view needs witness cosigning / gossip / a consistency
// proof against a previously trusted checkpoint (future work); (b) the entry's
// `integratedTime` - it is NOT covered by the inclusion proof, so callers must not
// present it as a cryptographically verified timestamp (this result never surfaces
// it). Binding the leaf to THIS AER's DSSE envelope needs the persisted Rekor body
// (Phase 3); until then a caller must NOT treat a verified inclusion as "this AER
// is anchored".

import { hexToBytes, timingSafeEqual } from '../bytes.js';
import { computeRootFromInclusionProof } from './merkle.js';
import { leafHashFromUuid, treeShardFromUuid } from './entry.js';
import { verifyCheckpoint, type CheckpointKey } from './checkpoint.js';
import type { Ed25519Verify } from '../keys.js';

const SHA256_BYTES = 32;

/** Parse the trailing tree id from a checkpoint origin "<name> - <treeId>". */
function treeIdFromOrigin(origin: string): bigint | null {
  const m = origin.match(/ - (\d+)\s*$/);
  if (!m) return null;
  try {
    return BigInt(m[1]!);
  } catch {
    return null;
  }
}

/** Big-endian unsigned integer value of a byte array. */
function bytesToBigInt(b: Uint8Array): bigint {
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  return v;
}

/** The stored inclusion proof (subset of a Rekor LogEntry verification). */
export interface InclusionProof {
  logIndex: number; // shard-local LEAF index — feeds the Merkle math with treeSize
  treeSize: number;
  rootHash: string; // hex
  hashes: string[]; // hex audit path
  checkpoint: string; // signed note
}

/** The stored transparency anchor (subset we rely on for offline verification). */
export interface TransparencyAnchor {
  uuid: string;
  logIndex?: number; // global/virtual index (NOT used for the Merkle proof)
  integratedTime?: number;
  verification: {
    inclusionProof: InclusionProof;
    signedEntryTimestamp?: string;
  };
}

export const REKOR_REASONS = {
  OK: 'rekor_evidence_verified',
  BAD_UUID: 'rekor_entry_uuid_invalid',
  PROOF_MALFORMED: 'rekor_inclusion_proof_malformed',
  ROOT_MISMATCH: 'rekor_recomputed_root_mismatch',
  CHECKPOINT_MISMATCH: 'rekor_checkpoint_commits_different_root',
  CHECKPOINT_UNSIGNED: 'rekor_checkpoint_signature_unverified',
  SHARD_MISMATCH: 'rekor_uuid_shard_not_bound_to_checkpoint',
  NO_TRUST_KEY: 'rekor_no_pinned_log_key',
} as const;

export type RekorReason = (typeof REKOR_REASONS)[keyof typeof REKOR_REASONS];

export interface RekorEvidenceResult {
  /** True iff the inclusion proof recomputes the checkpoint's signed root. */
  verified: boolean;
  /** Merkle proof recomputed the proof's stated root. */
  inclusionValid: boolean;
  /** Checkpoint (treeSize, rootHash) matches the inclusion proof. */
  checkpointConsistent: boolean;
  /** Checkpoint signature verified against a pinned key. */
  checkpointSignatureValid: boolean;
  treeSize: number;
  /** Signer name of the verifying checkpoint key, when signed. */
  signedBy?: string;
  reasons: RekorReason[];
}

export interface RekorVerifyOptions {
  /** Pinned checkpoint-signing keys (Rekor log keys) from the trust root. */
  keys: CheckpointKey[];
  /** Ed25519 fallback for runtimes lacking native subtle Ed25519. */
  ed25519Verify?: Ed25519Verify;
}

/**
 * Verify Rekor inclusion evidence for an anchored entry, fully offline.
 */
export async function verifyRekorEvidence(
  anchor: TransparencyAnchor,
  opts: RekorVerifyOptions,
): Promise<RekorEvidenceResult> {
  const reasons: RekorReason[] = [];
  const fail = (
    partial: Partial<RekorEvidenceResult> & { treeSize: number },
  ): RekorEvidenceResult => ({
    verified: false,
    inclusionValid: false,
    checkpointConsistent: false,
    checkpointSignatureValid: false,
    ...partial,
    reasons,
  });

  const ip = anchor?.verification?.inclusionProof;
  if (
    !ip ||
    !Number.isSafeInteger(ip.treeSize) ||
    ip.treeSize < 1 ||
    !Number.isSafeInteger(ip.logIndex) ||
    ip.logIndex < 0 ||
    !Array.isArray(ip.hashes) ||
    typeof ip.rootHash !== 'string' ||
    typeof ip.checkpoint !== 'string'
  ) {
    reasons.push(REKOR_REASONS.PROOF_MALFORMED);
    return fail({ treeSize: 0 });
  }
  const treeSize = ip.treeSize;

  let leafHash: Uint8Array;
  try {
    leafHash = leafHashFromUuid(anchor.uuid);
  } catch {
    reasons.push(REKOR_REASONS.BAD_UUID);
    return fail({ treeSize });
  }

  // 1 + 2: recompute the Merkle root and compare against the proof's stated root.
  // computeRootFromInclusionProof enforces 32-byte leaf + audit-path nodes; the
  // stated root must also be exactly 32 bytes or the comparison is meaningless.
  let recomputed: Uint8Array;
  let statedRoot: Uint8Array;
  try {
    statedRoot = hexToBytes(ip.rootHash);
    if (statedRoot.length !== SHA256_BYTES) throw new Error('rootHash not 32 bytes');
    const proof = ip.hashes.map((h) => hexToBytes(h));
    recomputed = await computeRootFromInclusionProof(leafHash, ip.logIndex, treeSize, proof);
  } catch {
    reasons.push(REKOR_REASONS.PROOF_MALFORMED);
    return fail({ treeSize });
  }
  const inclusionValid = timingSafeEqual(recomputed, statedRoot);
  if (!inclusionValid) {
    reasons.push(REKOR_REASONS.ROOT_MISMATCH);
    return fail({ treeSize });
  }

  if (opts.keys.length === 0) {
    reasons.push(REKOR_REASONS.NO_TRUST_KEY);
    return fail({ treeSize, inclusionValid });
  }

  // 3 + 4: checkpoint must commit to the same root/size AND be signed by a pinned key.
  const cp = await verifyCheckpoint(ip.checkpoint, opts.keys, opts.ed25519Verify);
  const checkpointConsistent =
    cp.treeSize === treeSize &&
    cp.rootHash.length === SHA256_BYTES &&
    timingSafeEqual(cp.rootHash, statedRoot);
  if (!checkpointConsistent) {
    reasons.push(REKOR_REASONS.CHECKPOINT_MISMATCH);
    return fail({ treeSize, inclusionValid });
  }
  if (!cp.valid) {
    reasons.push(REKOR_REASONS.CHECKPOINT_UNSIGNED);
    return fail({ treeSize, inclusionValid, checkpointConsistent });
  }

  // 5: bind the sharded UUID prefix to the checkpoint's tree. Only the trailing 64
  // hex (the leaf hash) drives the Merkle proof; the 16-hex shard prefix is the log
  // tree id (big-endian uint64) and MUST equal the checkpoint origin's tree id, or a
  // forged prefix would ride a valid proof from a different shard. Unsharded (64-hex)
  // UUIDs carry no prefix to bind and are accepted as-is.
  const shard = treeShardFromUuid(anchor.uuid);
  if (shard) {
    const originTreeId = treeIdFromOrigin(cp.origin);
    if (originTreeId === null || bytesToBigInt(shard) !== originTreeId) {
      reasons.push(REKOR_REASONS.SHARD_MISMATCH);
      return fail({ treeSize, inclusionValid, checkpointConsistent, checkpointSignatureValid: true });
    }
  }

  reasons.push(REKOR_REASONS.OK);
  return {
    verified: true,
    inclusionValid: true,
    checkpointConsistent: true,
    checkpointSignatureValid: true,
    treeSize,
    ...(cp.signedBy ? { signedBy: cp.signedBy } : {}),
    reasons,
  };
}
