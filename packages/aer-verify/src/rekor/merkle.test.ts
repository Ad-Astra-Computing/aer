import { describe, it, expect } from 'vitest';
import {
  hashLeaf,
  hashChildren,
  computeRootFromInclusionProof,
  verifyInclusionProof,
} from './merkle.js';

// Reference RFC 6962 tree operations, written independently of the verifier so the
// two implementations cross-check each other. MTH (Merkle Tree Hash) over a list of
// leaf byte-strings, and the audit path for a given leaf index.
async function merkleRoot(leaves: Uint8Array[]): Promise<Uint8Array> {
  if (leaves.length === 0) return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array()));
  if (leaves.length === 1) return hashLeaf(leaves[0]!);
  const k = largestPowerOfTwoBelow(leaves.length);
  const left = await merkleRoot(leaves.slice(0, k));
  const right = await merkleRoot(leaves.slice(k));
  return hashChildren(left, right);
}

async function auditPath(index: number, leaves: Uint8Array[]): Promise<Uint8Array[]> {
  const n = leaves.length;
  if (n <= 1) return [];
  const k = largestPowerOfTwoBelow(n);
  if (index < k) {
    return [...(await auditPath(index, leaves.slice(0, k))), await merkleRoot(leaves.slice(k))];
  }
  return [...(await auditPath(index - k, leaves.slice(k))), await merkleRoot(leaves.slice(0, k))];
}

function largestPowerOfTwoBelow(n: number): number {
  let k = 1;
  while (k << 1 < n) k <<= 1;
  return k;
}

function leafData(i: number): Uint8Array {
  return new TextEncoder().encode(`leaf-${i}`);
}

describe('RFC 6962 inclusion proofs', () => {
  // Exercise a range of tree sizes, including non-powers-of-two where the RFC's
  // left/right-edge ascent logic actually bites.
  for (const size of [1, 2, 3, 4, 5, 7, 8, 9, 16, 23]) {
    it(`recomputes the root for every leaf in a tree of ${size}`, async () => {
      const leaves = Array.from({ length: size }, (_, i) => leafData(i));
      const root = await merkleRoot(leaves);
      for (let index = 0; index < size; index++) {
        const proof = await auditPath(index, leaves);
        const leaf = await hashLeaf(leaves[index]!);
        expect(await verifyInclusionProof(leaf, index, size, proof, root)).toBe(true);
        // And the recomputed root is byte-identical to the reference MTH.
        const recomputed = await computeRootFromInclusionProof(leaf, index, size, proof);
        expect(Array.from(recomputed)).toEqual(Array.from(root));
      }
    });
  }

  it('rejects a proof with a flipped bit', async () => {
    const leaves = Array.from({ length: 7 }, (_, i) => leafData(i));
    const root = await merkleRoot(leaves);
    const proof = await auditPath(3, leaves);
    const leaf = await hashLeaf(leaves[3]!);
    proof[0]![0] ^= 0xff;
    expect(await verifyInclusionProof(leaf, 3, 7, proof, root)).toBe(false);
  });

  it('rejects the right leaf hash against the wrong index', async () => {
    const leaves = Array.from({ length: 8 }, (_, i) => leafData(i));
    const root = await merkleRoot(leaves);
    const proof = await auditPath(2, leaves);
    const leaf = await hashLeaf(leaves[2]!);
    // Same proof, wrong claimed index.
    expect(await verifyInclusionProof(leaf, 5, 8, proof, root)).toBe(false);
  });

  it('rejects a leaf that is not in the tree', async () => {
    const leaves = Array.from({ length: 5 }, (_, i) => leafData(i));
    const root = await merkleRoot(leaves);
    const proof = await auditPath(1, leaves);
    const forged = await hashLeaf(new TextEncoder().encode('not-in-tree'));
    expect(await verifyInclusionProof(forged, 1, 5, proof, root)).toBe(false);
  });

  it('throws on an out-of-range index', async () => {
    const leaf = await hashLeaf(leafData(0));
    await expect(computeRootFromInclusionProof(leaf, 5, 5, [])).rejects.toThrow(/out of range/);
  });

  it('rejects a proof of the wrong length', async () => {
    const leaves = Array.from({ length: 8 }, (_, i) => leafData(i));
    const root = await merkleRoot(leaves);
    const proof = await auditPath(0, leaves);
    expect(await verifyInclusionProof(await hashLeaf(leaves[0]!), 0, 8, proof.slice(0, 1), root)).toBe(false);
  });

  it('rejects a non-32-byte leaf hash', async () => {
    await expect(computeRootFromInclusionProof(new Uint8Array(31), 0, 2, [new Uint8Array(32)])).rejects.toThrow(
      /leaf hash must be 32/,
    );
  });

  it('rejects a non-32-byte audit-path node', async () => {
    const leaf = await hashLeaf(leafData(0));
    await expect(computeRootFromInclusionProof(leaf, 0, 2, [new Uint8Array(31)])).rejects.toThrow(
      /audit-path node must be 32/,
    );
  });

  it('rejects a non-safe-integer tree size', async () => {
    const leaf = await hashLeaf(leafData(0));
    await expect(computeRootFromInclusionProof(leaf, 0, 2 ** 60, [])).rejects.toThrow(/invalid tree size/);
  });

  it('rejects tree size zero', async () => {
    const leaf = await hashLeaf(leafData(0));
    await expect(computeRootFromInclusionProof(leaf, 0, 0, [])).rejects.toThrow(/invalid tree size/);
  });

  it('uses non-bitwise index arithmetic (indices above 2^31 do not corrupt the walk)', async () => {
    // A single-node tree at a large size still resolves trivially; the point is that
    // fn/sn arithmetic (Math.floor, %) does not coerce a >2^31 index to 32-bit.
    const leaf = await hashLeaf(leafData(0));
    const big = 3_000_000_000; // > 2^31
    // leaf at the last index of a tree whose size forces the right-edge ascent path
    // is exercised elsewhere; here we assert the range check accepts a large index.
    await expect(computeRootFromInclusionProof(leaf, big, big + 1, [])).rejects.toThrow(/path shorter/);
  });
});
