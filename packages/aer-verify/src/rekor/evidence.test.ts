import { describe, it, expect } from 'vitest';
import { verifyRekorEvidence, REKOR_REASONS, type TransparencyAnchor } from './evidence.js';
import { hashLeaf, hashChildren } from './merkle.js';
import { keyHint, type CheckpointKey } from './checkpoint.js';
import { bytesToHex, bytesToBase64 } from '../bytes.js';

// --- Reference RFC 6962 tree (independent of the verifier), as in merkle.test.ts ---
function largestPowerOfTwoBelow(n: number): number {
  let k = 1;
  while (k << 1 < n) k <<= 1;
  return k;
}
async function merkleRoot(leaves: Uint8Array[]): Promise<Uint8Array> {
  if (leaves.length === 1) return hashLeaf(leaves[0]!);
  const k = largestPowerOfTwoBelow(leaves.length);
  return hashChildren(await merkleRoot(leaves.slice(0, k)), await merkleRoot(leaves.slice(k)));
}
async function auditPath(index: number, leaves: Uint8Array[]): Promise<Uint8Array[]> {
  if (leaves.length <= 1) return [];
  const k = largestPowerOfTwoBelow(leaves.length);
  if (index < k) return [...(await auditPath(index, leaves.slice(0, k))), await merkleRoot(leaves.slice(k))];
  return [...(await auditPath(index - k, leaves.slice(k))), await merkleRoot(leaves.slice(0, k))];
}

// --- Build a synthetic anchor with a checkpoint signed by our own P-256 key ---
const NAME = 'test.log.example';

async function buildScenario(size: number, index: number) {
  const leafData = Array.from({ length: size }, (_, i) => new TextEncoder().encode(`entry-${i}`));
  const leafHashes = await Promise.all(leafData.map((d) => hashLeaf(d)));
  const root = await merkleRoot(leafData);
  const proof = await auditPath(index, leafData);
  const uuid = bytesToHex(leafHashes[index]!); // Rekor UUID == leaf hash hex

  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const hint = await keyHint(spki);

  async function makeCheckpoint(committedRoot: Uint8Array, committedSize: number): Promise<string> {
    const body = `${NAME} - 42\n${committedSize}\n${bytesToBase64(committedRoot)}\n`;
    const sig = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(body)),
    );
    const line = bytesToBase64(new Uint8Array([...hint, ...sig]));
    return `${body}\n— ${NAME} ${line}\n`;
  }

  const key: CheckpointKey = { name: NAME, spki, algorithm: 'ecdsa-p256' };
  const anchor = (checkpoint: string): TransparencyAnchor => ({
    uuid,
    verification: {
      inclusionProof: {
        logIndex: index,
        treeSize: size,
        rootHash: bytesToHex(root),
        hashes: proof.map(bytesToHex),
        checkpoint,
      },
    },
  });

  return { root, size, key, anchor, makeCheckpoint };
}

describe('verifyRekorEvidence', () => {
  it('verifies a well-formed anchor end to end', async () => {
    const s = await buildScenario(23, 7);
    const cp = await s.makeCheckpoint(s.root, s.size);
    const res = await verifyRekorEvidence(s.anchor(cp), { keys: [s.key] });
    expect(res.verified).toBe(true);
    expect(res.inclusionValid).toBe(true);
    expect(res.checkpointConsistent).toBe(true);
    expect(res.checkpointSignatureValid).toBe(true);
    expect(res.signedBy).toBe(NAME);
    expect(res.reasons).toContain(REKOR_REASONS.OK);
  });

  it('verifies across many tree sizes and indices', async () => {
    for (const [size, index] of [[1, 0], [2, 1], [5, 4], [8, 3], [16, 0]] as const) {
      const s = await buildScenario(size, index);
      const cp = await s.makeCheckpoint(s.root, s.size);
      const res = await verifyRekorEvidence(s.anchor(cp), { keys: [s.key] });
      expect(res.verified, `size=${size} index=${index}`).toBe(true);
    }
  });

  it('fails when the inclusion proof recomputes a different root', async () => {
    const s = await buildScenario(8, 2);
    const cp = await s.makeCheckpoint(s.root, s.size);
    const a = s.anchor(cp);
    a.verification.inclusionProof.rootHash = a.verification.inclusionProof.rootHash.replace(/^./, (c) => (c === '0' ? '1' : '0'));
    const res = await verifyRekorEvidence(a, { keys: [s.key] });
    expect(res.verified).toBe(false);
    expect(res.reasons).toContain(REKOR_REASONS.ROOT_MISMATCH);
  });

  it('fails with no pinned key even when inclusion is valid', async () => {
    const s = await buildScenario(8, 2);
    const cp = await s.makeCheckpoint(s.root, s.size);
    const res = await verifyRekorEvidence(s.anchor(cp), { keys: [] });
    expect(res.verified).toBe(false);
    expect(res.inclusionValid).toBe(true);
    expect(res.reasons).toContain(REKOR_REASONS.NO_TRUST_KEY);
  });

  it('fails when the checkpoint commits to a different root', async () => {
    const s = await buildScenario(8, 2);
    const wrongRoot = new Uint8Array(32).fill(9);
    const cp = await s.makeCheckpoint(wrongRoot, s.size); // signed, but wrong root
    const res = await verifyRekorEvidence(s.anchor(cp), { keys: [s.key] });
    expect(res.verified).toBe(false);
    expect(res.reasons).toContain(REKOR_REASONS.CHECKPOINT_MISMATCH);
  });

  it('fails when the checkpoint is signed by an unpinned key', async () => {
    const s = await buildScenario(8, 2);
    const cp = await s.makeCheckpoint(s.root, s.size);
    const stranger = await buildScenario(8, 2); // different key
    const res = await verifyRekorEvidence(s.anchor(cp), { keys: [stranger.key] });
    expect(res.verified).toBe(false);
    expect(res.reasons).toContain(REKOR_REASONS.CHECKPOINT_UNSIGNED);
  });

  it('binds a sharded UUID prefix to the checkpoint tree id', async () => {
    // buildScenario signs a checkpoint with origin "<name> - 42", so tree id = 42.
    const s = await buildScenario(8, 2);
    const cp = await s.makeCheckpoint(s.root, s.size);
    const a = s.anchor(cp);
    const shardHex = (42).toString(16).padStart(16, '0'); // uint64 42
    a.uuid = shardHex + a.uuid; // 80-hex sharded UUID, prefix == tree id
    const res = await verifyRekorEvidence(a, { keys: [s.key] });
    expect(res.verified).toBe(true);
  });

  it('rejects a sharded UUID whose prefix does not match the checkpoint tree id', async () => {
    const s = await buildScenario(8, 2);
    const cp = await s.makeCheckpoint(s.root, s.size);
    const a = s.anchor(cp);
    a.uuid = 'ffffffffffffffff' + a.uuid; // wrong shard prefix
    const res = await verifyRekorEvidence(a, { keys: [s.key] });
    expect(res.verified).toBe(false);
    expect(res.reasons).toContain(REKOR_REASONS.SHARD_MISMATCH);
  });

  it('rejects an anchor with a non-safe-integer tree size', async () => {
    const s = await buildScenario(8, 2);
    const cp = await s.makeCheckpoint(s.root, s.size);
    const a = s.anchor(cp);
    a.verification.inclusionProof.treeSize = 2 ** 60;
    const res = await verifyRekorEvidence(a, { keys: [s.key] });
    expect(res.verified).toBe(false);
    expect(res.reasons).toContain(REKOR_REASONS.PROOF_MALFORMED);
  });

  it('fails cleanly on a malformed anchor', async () => {
    const res = await verifyRekorEvidence({ uuid: 'zz', verification: {} } as unknown as TransparencyAnchor, {
      keys: [],
    });
    expect(res.verified).toBe(false);
    expect(res.reasons).toContain(REKOR_REASONS.PROOF_MALFORMED);
  });

  it('never throws on a checkpoint string with a huge bogus audit path', async () => {
    const s = await buildScenario(8, 2);
    const cp = await s.makeCheckpoint(s.root, s.size);
    const a = s.anchor(cp);
    // An attacker-controlled audit path much longer than the tree height must fail
    // as an ordinary malformed proof, not throw out of verifyRekorEvidence.
    a.verification.inclusionProof.hashes = Array(50000).fill('00'.repeat(32));
    await expect(verifyRekorEvidence(a, { keys: [s.key] })).resolves.toMatchObject({ verified: false });
  });

  it('never throws when the checkpoint text has no signature separator', async () => {
    const s = await buildScenario(8, 2);
    const a = s.anchor('not a real checkpoint, no blank line here');
    await expect(verifyRekorEvidence(a, { keys: [s.key] })).resolves.toMatchObject({ verified: false });
  });
});
