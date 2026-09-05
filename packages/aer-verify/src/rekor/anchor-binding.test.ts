import { describe, it, expect } from 'vitest';
import {
  verifyAnchoredEvidence,
  ANCHOR_REASONS,
  type AnchorEvidence,
  type BundleIdentity,
} from './anchor-binding.js';
import { hashLeaf, hashChildren, sha256 } from './merkle.js';
import { keyHint, type CheckpointKey } from './checkpoint.js';
import { paeBytes, ATTESTATION_TYPE, ATTESTATION_SCHEMA, type DsseEnvelope } from '../dsse.js';
import { signingKeyIdFromPublicKey } from '../keys.js';
import { bytesToHex, bytesToBase64, base64ToBytes, utf8 } from '../bytes.js';
import type { PinnedKey } from '../result.js';

// --- Reference RFC 6962 tree (independent of the verifier) -------------------------
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

const CP_NAME = 'test.rekor.example';

// Build a fully-bound anchor: a real Ed25519 AER key signs a DSSE attestation, a
// Rekor body commits to it, that body is the leaf at `index` of a Merkle tree, and a
// P-256 checkpoint signs the root. Returns everything the verifier needs plus knobs
// to corrupt each link.
async function buildAnchor(opts?: {
  aerId?: string;
  canonicalHash?: string;
  mutateBody?: (b: Record<string, unknown>) => Record<string, unknown>;
}) {
  const aerId = opts?.aerId ?? 'aer_test_0001';
  const canonicalHash = opts?.canonicalHash ?? 'a'.repeat(64);

  // 1. AER signing key (Ed25519) + attestation + DSSE envelope.
  const aerPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', aerPair.publicKey));
  const signingKeyId = await signingKeyIdFromPublicKey(rawPub);

  const attestation = {
    _type: ATTESTATION_SCHEMA,
    aer_id: aerId,
    canonical_hash: canonicalHash,
    signing_key_id: signingKeyId,
    signed_at: '2026-07-20T00:00:00.000Z',
  };
  const payloadBytes = utf8(JSON.stringify(attestation));
  const payloadB64 = bytesToBase64(payloadBytes);
  const pae = paeBytes(ATTESTATION_TYPE, payloadBytes);
  const envSig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, aerPair.privateKey, pae));
  const envSigB64 = bytesToBase64(envSig);
  const envelope: DsseEnvelope = {
    payloadType: ATTESTATION_TYPE,
    payload: payloadB64,
    signatures: [{ sig: envSigB64 }],
  };

  // 2. Rekor dsse:0.0.1 body committing to the envelope (payload hash + signature).
  const payloadHashHex = bytesToHex(await sha256(payloadBytes));
  const defaultBody: Record<string, unknown> = {
    apiVersion: '0.0.1',
    kind: 'dsse',
    spec: {
      envelopeHash: { algorithm: 'sha256', value: bytesToHex(await sha256(utf8(JSON.stringify(envelope)))) },
      payloadHash: { algorithm: 'sha256', value: payloadHashHex },
      signatures: [{ signature: envSigB64, verifier: 'cGVt' }],
    },
  };
  const bodyObj = opts?.mutateBody ? opts.mutateBody(defaultBody) : defaultBody;
  const bodyBytes = utf8(JSON.stringify(bodyObj));
  const bodyB64 = bytesToBase64(bodyBytes);

  // 3. Merkle tree: the body is the leaf preimage at `index`.
  const size = 8;
  const index = 3;
  const leaves = Array.from({ length: size }, (_, i) => (i === index ? bodyBytes : utf8(`filler-${i}`)));
  const root = await merkleRoot(leaves);
  const proof = await auditPath(index, leaves);
  const leafHex = bytesToHex(await hashLeaf(bodyBytes));

  // 4. P-256 checkpoint signing the root.
  const cpPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', cpPair.publicKey));
  await keyHint(spki);
  const cpBody = `${CP_NAME} - 99\n${size}\n${bytesToBase64(root)}\n`;
  const cpSig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, cpPair.privateKey, utf8(cpBody)));
  const line = bytesToBase64(new Uint8Array([...(await keyHint(spki)), ...cpSig]));
  const checkpoint = `${cpBody}\n— ${CP_NAME} ${line}\n`;

  const rekorKey: CheckpointKey = { name: CP_NAME, spki, algorithm: 'ecdsa-p256' };
  const aerKey: PinnedKey = { signing_key_id: signingKeyId, public_key_hex: bytesToHex(rawPub) };
  const bundle: BundleIdentity = { aer_id: aerId, canonical_hash: canonicalHash, signing_key_id: signingKeyId };

  const anchor: AnchorEvidence = {
    uuid: leafHex,
    body: bodyB64,
    envelope,
    verification: {
      inclusionProof: {
        logIndex: index,
        treeSize: size,
        rootHash: bytesToHex(root),
        hashes: proof.map(bytesToHex),
        checkpoint,
      },
    },
  };

  return { anchor, bundle, rekorKey, aerKey, bodyObj, envelope };
}

const optsFor = (rekorKey: CheckpointKey, aerKey: PinnedKey) => ({ rekorLogs: [rekorKey], aerKeys: [aerKey] });

describe('verifyAnchoredEvidence', () => {
  it('verifies a fully-bound anchor end to end', async () => {
    const s = await buildAnchor();
    const res = await verifyAnchoredEvidence(s.anchor, s.bundle, optsFor(s.rekorKey, s.aerKey));
    expect(res.anchored).toBe(true);
    expect(res.rekor.verified).toBe(true);
    expect(res.bodyBindsLeaf).toBe(true);
    expect(res.bodyBindsEnvelope).toBe(true);
    expect(res.envelopeSignatureValid).toBe(true);
    expect(res.attestationBindsBundle).toBe(true);
    expect(res.reasons).toContain(ANCHOR_REASONS.OK);
  });

  it('stays UNANCHORED when the rekor inclusion evidence fails', async () => {
    const s = await buildAnchor();
    s.anchor.verification.inclusionProof.rootHash = s.anchor.verification.inclusionProof.rootHash.replace(/^./, (c) => (c === '0' ? '1' : '0'));
    const res = await verifyAnchoredEvidence(s.anchor, s.bundle, optsFor(s.rekorKey, s.aerKey));
    expect(res.anchored).toBe(false);
    expect(res.reasons).toContain(ANCHOR_REASONS.REKOR_UNVERIFIED);
  });

  it('stays UNANCHORED when the rekor body is absent (never partial-upgrade)', async () => {
    const s = await buildAnchor();
    delete s.anchor.body;
    const res = await verifyAnchoredEvidence(s.anchor, s.bundle, optsFor(s.rekorKey, s.aerKey));
    expect(res.anchored).toBe(false);
    expect(res.rekor.verified).toBe(true); // phase-2 proof still holds…
    expect(res.reasons).toContain(ANCHOR_REASONS.NO_BODY); // …but we do NOT claim anchored
  });

  it('rejects a body that is not the proven leaf preimage', async () => {
    const s = await buildAnchor();
    // A different-but-valid-JSON body no longer hashes to the committed leaf.
    const tampered = { ...s.bodyObj, extra: 'x' };
    s.anchor.body = bytesToBase64(utf8(JSON.stringify(tampered)));
    const res = await verifyAnchoredEvidence(s.anchor, s.bundle, optsFor(s.rekorKey, s.aerKey));
    expect(res.anchored).toBe(false);
    expect(res.reasons).toContain(ANCHOR_REASONS.BODY_LEAF_MISMATCH);
  });

  it('rejects a body over the size ceiling', async () => {
    const s = await buildAnchor();
    s.anchor.body = bytesToBase64(new Uint8Array(20 * 1024));
    const res = await verifyAnchoredEvidence(s.anchor, s.bundle, optsFor(s.rekorKey, s.aerKey));
    expect(res.anchored).toBe(false);
    expect(res.reasons).toContain(ANCHOR_REASONS.BODY_TOO_LARGE);
  });

  it('rejects when the body does not bind the presented envelope', async () => {
    const s = await buildAnchor();
    // Swap the envelope payload for a different (validly-signed-looking) one: the body's
    // payloadHash no longer matches. Re-sign is unnecessary - we test the C link.
    const otherPayload = bytesToBase64(utf8('{"_type":"x"}'));
    s.anchor.envelope = { ...s.envelope, payload: otherPayload };
    const res = await verifyAnchoredEvidence(s.anchor, s.bundle, optsFor(s.rekorKey, s.aerKey));
    expect(res.anchored).toBe(false);
    expect(res.bodyBindsLeaf).toBe(true);
    expect(res.reasons).toContain(ANCHOR_REASONS.BODY_ENVELOPE_MISMATCH);
  });

  it('rejects when no pinned AER key matches the bundle', async () => {
    const s = await buildAnchor();
    const res = await verifyAnchoredEvidence(s.anchor, s.bundle, { rekorLogs: [s.rekorKey], aerKeys: [] });
    expect(res.anchored).toBe(false);
    expect(res.bodyBindsEnvelope).toBe(true);
    expect(res.reasons).toContain(ANCHOR_REASONS.NO_AER_KEY);
  });

  it('rejects when the DSSE signature does not verify under the pinned key', async () => {
    const s = await buildAnchor();
    // Pin a DIFFERENT public key under the same key-id claim: the envelope sig fails.
    const other = await buildAnchor();
    const wrongKey: PinnedKey = { signing_key_id: s.aerKey.signing_key_id, public_key_hex: other.aerKey.public_key_hex };
    const res = await verifyAnchoredEvidence(s.anchor, s.bundle, { rekorLogs: [s.rekorKey], aerKeys: [wrongKey] });
    expect(res.anchored).toBe(false);
    expect(res.reasons).toContain(ANCHOR_REASONS.ENVELOPE_SIG_INVALID);
  });

  it('rejects when the attestation commits to a different aer_id', async () => {
    const s = await buildAnchor();
    const res = await verifyAnchoredEvidence(
      s.anchor,
      { ...s.bundle, aer_id: 'aer_someone_else' },
      optsFor(s.rekorKey, s.aerKey),
    );
    expect(res.anchored).toBe(false);
    expect(res.envelopeSignatureValid).toBe(true);
    expect(res.reasons).toContain(ANCHOR_REASONS.ATTESTATION_MISMATCH);
  });

  it('rejects a Rekor body of the wrong kind or apiVersion (leaf still matches)', async () => {
    for (const mutate of [
      (b: Record<string, unknown>) => ({ ...b, kind: 'hashedrekord' }),
      (b: Record<string, unknown>) => ({ ...b, apiVersion: '0.0.2' }),
    ]) {
      const s = await buildAnchor({ mutateBody: mutate });
      const res = await verifyAnchoredEvidence(s.anchor, s.bundle, optsFor(s.rekorKey, s.aerKey));
      expect(res.anchored).toBe(false);
      expect(res.bodyBindsLeaf).toBe(true); // the body IS the proven leaf…
      expect(res.reasons).toContain(ANCHOR_REASONS.BODY_MALFORMED); // …but not valid DSSE evidence
    }
  });

  it('rejects a Rekor body whose hashes are not sha256', async () => {
    const s = await buildAnchor({
      mutateBody: (b) => {
        const spec = { ...(b.spec as Record<string, unknown>) };
        spec.payloadHash = { algorithm: 'sha512', value: 'x' };
        return { ...b, spec };
      },
    });
    const res = await verifyAnchoredEvidence(s.anchor, s.bundle, optsFor(s.rekorKey, s.aerKey));
    expect(res.anchored).toBe(false);
    expect(res.reasons).toContain(ANCHOR_REASONS.BODY_MALFORMED);
  });

  it('rejects when the attestation commits to a different canonical hash', async () => {
    const s = await buildAnchor();
    const res = await verifyAnchoredEvidence(
      s.anchor,
      { ...s.bundle, canonical_hash: 'b'.repeat(64) },
      optsFor(s.rekorKey, s.aerKey),
    );
    expect(res.anchored).toBe(false);
    expect(res.reasons).toContain(ANCHOR_REASONS.ATTESTATION_MISMATCH);
  });

  it('never throws on a body whose JSON payload is deeply nested', async () => {
    const s = await buildAnchor();
    // The body is bounded to 16 KiB (BODY_TOO_LARGE), so a document nested past that
    // size limit cannot reach canonicalize's own depth guard; this exercises the
    // "still just a normal failed verdict" path for a body JSON.parse can choke on.
    let node: Record<string, unknown> = {};
    const root = node;
    for (let i = 0; i < 200; i++) {
      const next: Record<string, unknown> = {};
      node.next = next;
      node = next;
    }
    s.anchor.body = bytesToBase64(utf8(JSON.stringify({ ...s.bodyObj, extra: root })));
    await expect(
      verifyAnchoredEvidence(s.anchor, s.bundle, optsFor(s.rekorKey, s.aerKey)),
    ).resolves.toMatchObject({ anchored: false });
  });
});
