// RFC 6962 Merkle tree primitives - the transparency-log inclusion-proof math.
// Pure and spec-locked (independent of Rekor's entry serialization), so it can be
// fully tested against self-built trees. Used by the Rekor evidence verifier to
// confirm an anchored entry is committed to by a checkpoint's root hash.

/** SHA-256 via Web Crypto. */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const d = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return new Uint8Array(d);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** RFC 6962 leaf hash: SHA-256(0x00 || leaf_data). */
export function hashLeaf(leafData: Uint8Array): Promise<Uint8Array> {
  return sha256(concat(new Uint8Array([0x00]), leafData));
}

/** RFC 6962 internal node hash: SHA-256(0x01 || left || right). */
export function hashChildren(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
  return sha256(concat(new Uint8Array([0x01]), left, right));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Recompute the Merkle root from an inclusion proof, per RFC 6962 §2.1.1.
 * Given the leaf hash, its index, the tree size and the audit path, return the
 * computed root (which the caller compares against a checkpoint-signed root).
 * Throws on a structurally invalid proof (index out of range, wrong path length).
 */
const SHA256_BYTES = 32;

export async function computeRootFromInclusionProof(
  leafHash: Uint8Array,
  leafIndex: number,
  treeSize: number,
  proof: Uint8Array[],
): Promise<Uint8Array> {
  // Tree sizes and shard-local indices exceed 2^31, so all index arithmetic uses
  // Math.floor / % rather than bitwise ops (which coerce to signed 32-bit and would
  // silently corrupt the traversal for large trees). Require safe integers up front.
  if (!Number.isSafeInteger(treeSize) || treeSize < 1) {
    throw new Error(`inclusion proof: invalid tree size ${treeSize}`);
  }
  if (!Number.isSafeInteger(leafIndex) || leafIndex < 0 || leafIndex >= treeSize) {
    throw new Error(`inclusion proof: leaf index ${leafIndex} out of range for tree size ${treeSize}`);
  }
  if (leafHash.length !== SHA256_BYTES) {
    throw new Error(`inclusion proof: leaf hash must be ${SHA256_BYTES} bytes`);
  }
  for (const p of proof) {
    if (p.length !== SHA256_BYTES) {
      throw new Error(`inclusion proof: audit-path node must be ${SHA256_BYTES} bytes`);
    }
  }

  let fn = leafIndex;
  let sn = treeSize - 1;
  let r = leafHash;
  for (const p of proof) {
    if (sn === 0) {
      throw new Error('inclusion proof: path longer than the tree height');
    }
    if (fn % 2 === 1 || fn === sn) {
      r = await hashChildren(p, r);
      if (fn % 2 === 0) {
        // Ascend past the left edge until we reach a right child (or the root).
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      r = await hashChildren(r, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  if (sn !== 0) {
    throw new Error('inclusion proof: path shorter than the tree height');
  }
  return r;
}

/**
 * Verify an inclusion proof against an expected root. Returns false (never throws)
 * on any structural or hash mismatch, so callers can treat it as a plain predicate.
 */
export async function verifyInclusionProof(
  leafHash: Uint8Array,
  leafIndex: number,
  treeSize: number,
  proof: Uint8Array[],
  expectedRoot: Uint8Array,
): Promise<boolean> {
  try {
    const root = await computeRootFromInclusionProof(leafHash, leafIndex, treeSize, proof);
    return bytesEqual(root, expectedRoot);
  } catch {
    return false;
  }
}
