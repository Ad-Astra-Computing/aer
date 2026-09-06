import { describe, it, expect } from 'vitest';
import { hashBundleForSigning } from '@aer/schemas';
import { createInMemorySigner, signingKeyIdFromPublicKey, type Signer } from '@aer-oss/attestation-test-utils';
import { verifyAerBundle } from './verify-aer.js';
import { bytesToHex, hexToBytes, bytesToBase64, base64ToBytes, utf8 } from './bytes.js';
import { REASONS, type PinnedKey } from './result.js';
import { hashLeaf, hashChildren, sha256 } from './rekor/merkle.js';
import { keyHint, type CheckpointKey } from './rekor/checkpoint.js';
import { paeBytes, ATTESTATION_TYPE, ATTESTATION_SCHEMA, type DsseEnvelope } from './dsse.js';
import type { AnchorEvidence } from './rekor/anchor-binding.js';

// Build a minimally-shaped but genuinely signed bundle exactly the way the server
// does (generate.ts): hash the integrity-stripped object, sign the RAW hash bytes,
// derive the key-id from the public key. No DB needed - the verifier only cares
// about the canonical bytes + the signature.
async function signBundle(
  signer: Signer,
  body: Record<string, unknown>,
  opts: { anchored?: boolean } = {},
): Promise<Record<string, unknown>> {
  const hashHex = hashBundleForSigning(body);
  const sig = await signer.sign(hexToBytes(hashHex));
  return {
    ...body,
    integrity: {
      hash: hashHex,
      signature: bytesToBase64(sig),
      signing_key_id: signingKeyIdFromPublicKey(signer.publicKey()),
      anchored: opts.anchored ?? false,
    },
  };
}

const BODY = {
  aer_id: 'aer_verify_test_1',
  schema_version: 'aer.v1',
  observations: { domains_contacted: ['api.openai.com'], tools_used: ['lookup'] },
  impact_summary: { severity: 'none' },
};

describe('verifyAerBundle: signature path', () => {
  it('verifies a genuine bundle with the supplied public key', async () => {
    const signer = createInMemorySigner();
    const bundle = await signBundle(signer, BODY);
    const res = await verifyAerBundle(bundle, { publicKeyHex: bytesToHex(signer.publicKey()) });

    expect(res.ok).toBe(true);
    expect(res.aer_id).toBe('aer_verify_test_1');
    expect(res.checks.hash_match).toBe(true);
    expect(res.checks.signature_valid).toBe(true);
    expect(res.checks.key_id_binding).toBe(true);
    expect(res.reasons).toEqual([]);
  });

  it('verifies against a pinned key set (independent of any served key)', async () => {
    const signer = createInMemorySigner();
    const bundle = await signBundle(signer, BODY);
    const pinned: PinnedKey[] = [
      { signing_key_id: signingKeyIdFromPublicKey(signer.publicKey()), public_key_hex: bytesToHex(signer.publicKey()), status: 'active' },
    ];
    const res = await verifyAerBundle(bundle, { pinnedKeys: pinned });
    expect(res.ok).toBe(true);
    expect(res.checks.key_pinned).toBe(true);
  });

  it('fails a bundle whose body was tampered after signing (hash mismatch)', async () => {
    const signer = createInMemorySigner();
    const bundle = await signBundle(signer, BODY);
    (bundle['observations'] as Record<string, unknown>)['tools_used'] = ['exfiltrate'];
    const res = await verifyAerBundle(bundle, { publicKeyHex: bytesToHex(signer.publicKey()) });
    expect(res.ok).toBe(false);
    expect(res.checks.hash_match).toBe(false);
    expect(res.reasons).toContain(REASONS.HASH_MISMATCH);
  });

  it('fails a bundle with a tampered signature', async () => {
    const signer = createInMemorySigner();
    const bundle = await signBundle(signer, BODY);
    const integrity = bundle['integrity'] as Record<string, unknown>;
    const sig = base64ToBytes(integrity['signature'] as string);
    sig[0] ^= 0xff;
    integrity['signature'] = bytesToBase64(sig);
    const res = await verifyAerBundle(bundle, { publicKeyHex: bytesToHex(signer.publicKey()) });
    expect(res.ok).toBe(false);
    expect(res.checks.signature_valid).toBe(false);
    expect(res.reasons).toContain(REASONS.SIGNATURE_INVALID);
  });

  it('rejects a key-substitution attack: a self-consistent bundle+key whose id does not bind', async () => {
    // Attacker re-signs a forged body with THEIR key but keeps the victim's
    // signing_key_id claim. The key they serve does not derive that id.
    const attacker = createInMemorySigner();
    const forged = await signBundle(attacker, { ...BODY, observations: { domains_contacted: ['evil.example'], tools_used: [] } });
    (forged['integrity'] as Record<string, unknown>)['signing_key_id'] = '0000000000000000';
    const res = await verifyAerBundle(forged, { publicKeyHex: bytesToHex(attacker.publicKey()) });
    expect(res.ok).toBe(false);
    expect(res.checks.key_id_binding).toBe(false);
    expect(res.reasons).toContain(REASONS.KEY_ID_BINDING_MISMATCH);
  });

  it('fails when the key is required to be pinned but is not in the set', async () => {
    const signer = createInMemorySigner();
    const other = createInMemorySigner();
    const bundle = await signBundle(signer, BODY);
    const pinned: PinnedKey[] = [
      { signing_key_id: signingKeyIdFromPublicKey(other.publicKey()), public_key_hex: bytesToHex(other.publicKey()) },
    ];
    const res = await verifyAerBundle(bundle, { pinnedKeys: pinned, publicKeyHex: bytesToHex(signer.publicKey()) });
    expect(res.ok).toBe(false);
    expect(res.checks.key_pinned).toBe(false);
    expect(res.reasons).toContain(REASONS.KEY_NOT_PINNED);
  });

  it('returns bundle_missing_integrity for a bundle with no integrity block', async () => {
    const res = await verifyAerBundle({ aer_id: 'x' });
    expect(res.ok).toBe(false);
    expect(res.reasons).toEqual([REASONS.BUNDLE_MISSING_INTEGRITY]);
  });

  it('never reports anchored:true with no evidence, and marks a bare claim as claimed', async () => {
    const signer = createInMemorySigner();
    const bundle = await signBundle(signer, BODY, { anchored: true });
    const res = await verifyAerBundle(bundle, { publicKeyHex: bytesToHex(signer.publicKey()) });
    // Signature still verifies…
    expect(res.checks.signature_valid).toBe(true);
    // …but the (unsigned) anchor claim is NOT echoed as verified.
    expect(res.anchored).toBe(false);
    expect(res.checks.anchor.status).toBe('claimed');
    expect(res.checks.anchor.claim).toBe(true);
    expect(res.reasons).toContain(REASONS.ANCHOR_VERIFICATION_UNAVAILABLE);
    // ok stays true on the signature merits (anchor not required by default).
    expect(res.ok).toBe(true);
  });

  it('fails under requireAnchor when no anchor evidence is supplied', async () => {
    const signer = createInMemorySigner();
    const bundle = await signBundle(signer, BODY, { anchored: true });
    const res = await verifyAerBundle(bundle, { publicKeyHex: bytesToHex(signer.publicKey()), policy: { requireAnchor: true } });
    expect(res.ok).toBe(false);
    expect(res.reasons).toContain(REASONS.ANCHOR_REQUIRED_BY_POLICY);
  });
});

// verifyAerBundle's whole contract is that it resolves to a VerifiedAer, never
// throws, over ATTACKER-CONTROLLED bundle shapes. Each case here would previously
// have rejected with an uncaught error (a RangeError from stack overflow, or a
// TypeError from canonicalize's own NaN/bigint/Date guards) instead of resolving.
describe('verifyAerBundle never throws on a pathological bundle', () => {
  const validIntegrity = {
    hash: 'a'.repeat(64),
    signature: bytesToBase64(new Uint8Array(64)),
    signing_key_id: 'a721bb9bd8f31c8e',
  };

  it('resolves ok:false with canonicalize_error on a deeply-nested bundle instead of throwing', async () => {
    let node: Record<string, unknown> = {};
    const root = node;
    for (let i = 0; i < 20000; i++) {
      const next: Record<string, unknown> = {};
      node.next = next;
      node = next;
    }
    const bundle = { aer_id: 'x', integrity: validIntegrity, deep: root };

    const res = await verifyAerBundle(bundle, {
      publicKeyHex: '39ab92b60e2bdc22a4a30f80f960fa862653247fa501f1e88d181f373d053870',
    });
    expect(res.ok).toBe(false);
    expect(res.reasons).toContain(REASONS.CANONICALIZE_ERROR);
    expect(res.canonical_hash).toBe('');
  });

  it('resolves ok:false rather than throwing when the bundle is null', async () => {
    // A caller that hands us the result of a failed parse, or an API that
    // answered null, must get a verdict. Throwing here turns a fail-closed
    // check into a crash in whatever is doing the verifying.
    const res = await verifyAerBundle(null as unknown as Record<string, unknown>, { publicKeyHex: 'aa' });
    expect(res.ok).toBe(false);
    expect(res.reasons).toContain(REASONS.BUNDLE_MISSING_INTEGRITY);
  });

  it('resolves ok:false rather than throwing when the bundle is undefined', async () => {
    const res = await verifyAerBundle(undefined as unknown as Record<string, unknown>, { publicKeyHex: 'aa' });
    expect(res.ok).toBe(false);
    expect(res.reasons).toContain(REASONS.BUNDLE_MISSING_INTEGRITY);
  });

  it('resolves ok:false rather than throwing when the bundle is an array', async () => {
    const res = await verifyAerBundle([] as unknown as Record<string, unknown>, { publicKeyHex: 'aa' });
    expect(res.ok).toBe(false);
    expect(res.reasons).toContain(REASONS.BUNDLE_MISSING_INTEGRITY);
  });

  it('resolves ok:false with canonicalize_error on a non-finite number field', async () => {
    const bundle = { aer_id: 'x', integrity: validIntegrity, score: Infinity };
    const res = await verifyAerBundle(bundle, { publicKeyHex: 'aa' });
    expect(res.ok).toBe(false);
    expect(res.reasons).toContain(REASONS.CANONICALIZE_ERROR);
  });

  it('resolves ok:false with canonicalize_error on a bigint field', async () => {
    const bundle = { aer_id: 'x', integrity: validIntegrity, count: 10n };
    const res = await verifyAerBundle(bundle, { publicKeyHex: 'aa' });
    expect(res.ok).toBe(false);
    expect(res.reasons).toContain(REASONS.CANONICALIZE_ERROR);
  });

  it('resolves ok:false with canonicalize_error on a Date field', async () => {
    const bundle = { aer_id: 'x', integrity: validIntegrity, created_at: new Date() };
    const res = await verifyAerBundle(bundle, { publicKeyHex: 'aa' });
    expect(res.ok).toBe(false);
    expect(res.reasons).toContain(REASONS.CANONICALIZE_ERROR);
  });

  it('does not also report hash_mismatch when canonicalization itself failed', async () => {
    const bundle = { aer_id: 'x', integrity: validIntegrity, count: 10n };
    const res = await verifyAerBundle(bundle, { publicKeyHex: 'aa' });
    expect(res.reasons).toEqual(
      expect.arrayContaining([REASONS.CANONICALIZE_ERROR]),
    );
    expect(res.reasons).not.toContain(REASONS.HASH_MISMATCH);
  });
});

// Build a valid anchor whose DSSE attestation is signed by the bundle's OWN signer and
// commits to `canonicalHash`, then witnessed by a synthetic (test) Rekor log.
async function buildAnchorFor(signer: Signer, aerId: string, canonicalHash: string) {
  const attestation = {
    _type: ATTESTATION_SCHEMA,
    aer_id: aerId,
    canonical_hash: canonicalHash,
    signing_key_id: signingKeyIdFromPublicKey(signer.publicKey()),
    signed_at: '2026-07-20T00:00:00.000Z',
  };
  const payloadBytes = utf8(JSON.stringify(attestation));
  const sig = await signer.sign(paeBytes(ATTESTATION_TYPE, payloadBytes));
  const sigB64 = bytesToBase64(sig);
  const envelope: DsseEnvelope = {
    payloadType: ATTESTATION_TYPE,
    payload: bytesToBase64(payloadBytes),
    signatures: [{ sig: sigB64 }],
  };
  const bodyObj = {
    apiVersion: '0.0.1',
    kind: 'dsse',
    spec: {
      envelopeHash: { algorithm: 'sha256', value: bytesToHex(await sha256(utf8(JSON.stringify(envelope)))) },
      payloadHash: { algorithm: 'sha256', value: bytesToHex(await sha256(payloadBytes)) },
      signatures: [{ signature: sigB64, verifier: 'cGVt' }],
    },
  };
  const bodyBytes = utf8(JSON.stringify(bodyObj));

  // Single-leaf tree: the body is the only leaf, so root == hashLeaf(body).
  const root = await hashLeaf(bodyBytes);
  const cpPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', cpPair.publicKey));
  const cpBody = `rekor.test - 7\n1\n${bytesToBase64(root)}\n`;
  const cpSig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, cpPair.privateKey, utf8(cpBody)));
  const line = bytesToBase64(new Uint8Array([...(await keyHint(spki)), ...cpSig]));
  const checkpoint = `${cpBody}\n— rekor.test ${line}\n`;

  const anchor: AnchorEvidence = {
    uuid: bytesToHex(root),
    body: bytesToBase64(bodyBytes),
    envelope,
    verification: {
      inclusionProof: { logIndex: 0, treeSize: 1, rootHash: bytesToHex(root), hashes: [], checkpoint },
    },
  };
  const rekorKey: CheckpointKey = { name: 'rekor.test', spki, algorithm: 'ecdsa-p256' };
  return { anchor, rekorKey };
}

describe('verifyAerBundle: offline anchor (phase 3)', () => {
  it('reports anchored:true when the full offline chain verifies', async () => {
    const signer = createInMemorySigner();
    const bundle = await signBundle(signer, BODY, { anchored: true });
    const hash = (bundle['integrity'] as Record<string, unknown>)['hash'] as string;
    const { anchor, rekorKey } = await buildAnchorFor(signer, BODY.aer_id, hash);
    const pinned: PinnedKey[] = [
      { signing_key_id: signingKeyIdFromPublicKey(signer.publicKey()), public_key_hex: bytesToHex(signer.publicKey()) },
    ];

    const res = await verifyAerBundle(bundle, {
      pinnedKeys: pinned,
      anchorEvidence: anchor,
      rekorLogs: [rekorKey],
      policy: { requireAnchor: true },
    });
    expect(res.ok).toBe(true);
    expect(res.anchored).toBe(true);
    expect(res.checks.anchor.status).toBe('verified');
    expect(res.checks.anchor.claim_consistent).toBe(true);
    expect(res.reasons).toEqual([]);
  });

  it('stays anchored:false and flags claim inconsistency when the anchor binds a different bundle', async () => {
    const signer = createInMemorySigner();
    const bundle = await signBundle(signer, BODY, { anchored: true });
    // Anchor commits to a DIFFERENT canonical hash than this bundle.
    const { anchor, rekorKey } = await buildAnchorFor(signer, BODY.aer_id, 'f'.repeat(64));
    const pinned: PinnedKey[] = [
      { signing_key_id: signingKeyIdFromPublicKey(signer.publicKey()), public_key_hex: bytesToHex(signer.publicKey()) },
    ];

    const res = await verifyAerBundle(bundle, {
      pinnedKeys: pinned,
      anchorEvidence: anchor,
      rekorLogs: [rekorKey],
    });
    expect(res.anchored).toBe(false);
    expect(res.checks.anchor.status).toBe('invalid');
    expect(res.checks.anchor.claim_consistent).toBe(false);
    expect(res.reasons).toContain(REASONS.ANCHOR_EVIDENCE_INVALID);
    // The signature merits still hold; only the anchor is unverified.
    expect(res.checks.signature_valid).toBe(true);
  });

  it('marks a pre-backfill anchor (evidence present, no body) as claimed, not invalid', async () => {
    const signer = createInMemorySigner();
    const bundle = await signBundle(signer, BODY, { anchored: true });
    const hash = (bundle['integrity'] as Record<string, unknown>)['hash'] as string;
    const { anchor, rekorKey } = await buildAnchorFor(signer, BODY.aer_id, hash);
    // Legacy shape: the stored body has not been backfilled yet.
    const noBody: typeof anchor = { ...anchor };
    delete (noBody as { body?: string }).body;
    const pinned: PinnedKey[] = [
      { signing_key_id: signingKeyIdFromPublicKey(signer.publicKey()), public_key_hex: bytesToHex(signer.publicKey()) },
    ];

    const res = await verifyAerBundle(bundle, { pinnedKeys: pinned, anchorEvidence: noBody, rekorLogs: [rekorKey] });
    expect(res.anchored).toBe(false);
    expect(res.checks.anchor.status).toBe('claimed');
    expect(res.reasons).not.toContain(REASONS.ANCHOR_EVIDENCE_INVALID);
    // A claimed (incomplete) anchor does NOT downgrade the default verdict.
    expect(res.ok).toBe(true);
  });

  it('marks an anchor whose signing key is not pinned as claimed (incomplete key set)', async () => {
    const signer = createInMemorySigner();
    const bundle = await signBundle(signer, BODY, { anchored: true });
    const hash = (bundle['integrity'] as Record<string, unknown>)['hash'] as string;
    const { anchor, rekorKey } = await buildAnchorFor(signer, BODY.aer_id, hash);
    // The bundle's key is NOT in the pinned set, so the anchor cannot be confirmed -
    // but the signature still verifies via the supplied fallback key.
    const res = await verifyAerBundle(bundle, {
      publicKeyHex: bytesToHex(signer.publicKey()),
      anchorEvidence: anchor,
      rekorLogs: [rekorKey],
    });
    expect(res.checks.signature_valid).toBe(true);
    expect(res.anchored).toBe(false);
    expect(res.checks.anchor.status).toBe('claimed');
    expect(res.ok).toBe(true);
  });

  it('forces invalid when the caller flags the anchor evidence as malformed', async () => {
    const signer = createInMemorySigner();
    const bundle = await signBundle(signer, BODY, { anchored: true });
    const pinned: PinnedKey[] = [
      { signing_key_id: signingKeyIdFromPublicKey(signer.publicKey()), public_key_hex: bytesToHex(signer.publicKey()) },
    ];
    // Corrupt stored evidence: the projector reported malformed, so no clean
    // AnchorEvidence is passed - only the flag. It must drive `invalid`, never
    // soften to `claimed`, and it downgrades the overall verdict.
    const res = await verifyAerBundle(bundle, { pinnedKeys: pinned, anchorEvidenceMalformed: true });
    expect(res.checks.anchor.status).toBe('invalid');
    expect(res.reasons).toContain(REASONS.ANCHOR_EVIDENCE_INVALID);
    expect(res.ok).toBe(false);
  });

  it('marks an unverifiable anchor on a bundle that does NOT claim anchoring as invalid', async () => {
    const signer = createInMemorySigner();
    // anchored:false - the bundle makes no anchoring claim, yet evidence is present.
    const bundle = await signBundle(signer, BODY, { anchored: false });
    const hash = (bundle['integrity'] as Record<string, unknown>)['hash'] as string;
    const { anchor, rekorKey } = await buildAnchorFor(signer, BODY.aer_id, hash);
    // No pinned key ⇒ NO_AER_KEY. Because the bundle does not claim anchoring, this
    // anomaly is invalid (claimed is reserved for the bundle's own claim), not claimed.
    const res = await verifyAerBundle(bundle, {
      publicKeyHex: bytesToHex(signer.publicKey()),
      anchorEvidence: anchor,
      rekorLogs: [rekorKey],
    });
    expect(res.checks.signature_valid).toBe(true);
    expect(res.checks.anchor.status).toBe('invalid');
    expect(res.ok).toBe(false);
  });
});
