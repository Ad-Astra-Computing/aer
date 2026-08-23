import {
  verifyAerBundle,
  builtinTrustRoot,
  REASONS,
  type VerifiedAer,
  type AnchorStatus,
  type AnchorEvidence,
} from '@adastracomputing/aer-verify';

export interface VerifyOptions {
  baseUrl: string;
  aerId: string;
  fetchImpl?: typeof fetch;
  /** Override the trust root (pinned AER signing keys + Rekor log keys). Defaults to
   *  the builtin root. Lets an enterprise pin its own keys (and lets tests exercise the
   *  happy path without the private key behind a builtin-pinned key). */
  trustRoot?: ReturnType<typeof builtinTrustRoot>;
}

export interface VerifyResult {
  aer_id: string;
  hash_match: boolean;
  signature_valid: boolean;
  verified: boolean;
  /** True ONLY when the full offline anchor chain verified (anchor_status==='verified'). */
  anchored: boolean;
  /** Four-state anchor result: verified | claimed | invalid | none. */
  anchor_status: AnchorStatus;
  canonical_hash: string;
  signing_key_id: string;
  reason?: string;
}

interface AerBundle {
  aer_id: string;
  integrity: {
    hash: string;
    signature: string;
    signing_key_id: string;
    anchored: boolean;
  };
  [key: string]: unknown;
}

export interface BundleSignatureResult {
  hash_match: boolean;
  signature_valid: boolean;
  verified: boolean;
  anchored: boolean;
  canonical_hash: string;
  signing_key_id: string;
  reason?: string;
}

interface KeyResponse {
  signing_key_id: string;
  sig_alg: string;
  public_key_hex: string;
}

// Map the core's reason codes to the legacy single-reason string the CLI has
// always surfaced, so existing scripts + tests keep working.
function legacyReason(res: VerifiedAer): string | undefined {
  if (res.reasons.includes(REASONS.KEY_ID_BINDING_MISMATCH)) return 'key_id_binding_mismatch';
  if (res.reasons.includes(REASONS.SIGNATURE_ERROR)) return 'sig_error';
  // A mathematically-valid signature under a key the trust root does not pin: the record
  // is self-consistent but its provenance is untrusted (surfaced so `verified:false` is
  // explained rather than bare).
  if (res.reasons.includes(REASONS.KEY_NOT_PINNED)) return 'key_not_pinned';
  return undefined;
}

// Verify a bundle OBJECT (already in hand): recompute the canonical hash and check
// the Ed25519 signature against the public signing key (fetched from the public
// /v1/keys endpoint - public, not a secret). Used by both `aer verify` (which
// fetches the bundle first) and `aer commitments verify` (which must confirm the
// bundle is genuine signed evidence before it trusts any commitment tag).
//
// The cryptography now lives in @adastracomputing/aer-verify - the same audited,
// dependency-free core the browser console and third parties use, so the CLI can
// no longer drift from the reference implementation. This function keeps the
// network concerns (fetching the key, 404 handling) the core deliberately omits.
export async function verifyBundleSignature(
  bundle: Record<string, unknown>,
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<BundleSignatureResult> {
  const base = baseUrl.replace(/\/$/, '');
  const integrity = bundle['integrity'] as AerBundle['integrity'] | undefined;
  if (!integrity || typeof integrity.hash !== 'string' || typeof integrity.signature !== 'string' || typeof integrity.signing_key_id !== 'string') {
    return { hash_match: false, signature_valid: false, verified: false, anchored: false, canonical_hash: '', signing_key_id: '', reason: 'bundle_missing_integrity' };
  }

  const keyRes = await fetchImpl(`${base}/v1/keys/${integrity.signing_key_id}`);
  if (!keyRes.ok) {
    return { hash_match: false, signature_valid: false, verified: false, anchored: !!integrity.anchored, canonical_hash: '', signing_key_id: integrity.signing_key_id, reason: `key_not_found: ${keyRes.status}` };
  }
  const keyData = (await keyRes.json()) as KeyResponse;

  const res = await verifyAerBundle(bundle, { publicKeyHex: keyData.public_key_hex });

  const out: BundleSignatureResult = {
    hash_match: res.checks.hash_match,
    signature_valid: res.checks.signature_valid,
    verified: res.ok,
    // Phase 1 preserves the historical behaviour of echoing the (unsigned) anchor
    // claim; Phase 2 replaces this with the cryptographically verified value once
    // the CLI fetches anchor.json and the core verifies the Rekor inclusion proof.
    anchored: res.checks.anchor.claim === true,
    canonical_hash: res.canonical_hash,
    signing_key_id: res.signing_key_id,
  };
  const reason = legacyReason(res);
  if (reason !== undefined) out.reason = reason;
  return out;
}

export async function verifyAer(opts: VerifyOptions): Promise<VerifyResult> {
  const base = opts.baseUrl.replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;

  // 1. Download the canonical bundle.
  const bundleRes = await fetchImpl(`${base}/v1/aers/${opts.aerId}/bundle`);
  if (!bundleRes.ok) {
    throw new Error(`failed to fetch bundle: ${bundleRes.status} ${await bundleRes.text()}`);
  }
  const bundle = (await bundleRes.json()) as AerBundle;
  const integrity = bundle.integrity;
  if (!integrity || typeof integrity.signing_key_id !== 'string') {
    return {
      aer_id: bundle.aer_id ?? '', hash_match: false, signature_valid: false, verified: false,
      anchored: false, anchor_status: 'none', canonical_hash: '', signing_key_id: '',
      reason: 'bundle_missing_integrity',
    };
  }

  // 2. Fetch the public signing key (fallback for the signature when the key is not
  //    pinned; the key is public, not a secret).
  let publicKeyHex: string | undefined;
  const keyRes = await fetchImpl(`${base}/v1/keys/${integrity.signing_key_id}`);
  if (keyRes.ok) publicKeyHex = ((await keyRes.json()) as KeyResponse).public_key_hex;

  // 3. Fetch the anchor evidence. Three outcomes:
  //    - 404 → no evidence; the verdict follows the bundle's own anchoring claim.
  //    - 200 projection_status:'malformed' → the stored evidence is PRESENT but corrupt.
  //      That is a real failure: the anchor is forced to `invalid` (never soft `claimed`).
  //    - 200 evidence → the offline A-D chain can bind it (Rekor inclusion proof + leaf
  //      body + DSSE envelope) and reach a VERIFIED anchor without trusting the server.
  let anchorEvidence: AnchorEvidence | undefined;
  let anchorEvidenceMalformed = false;
  const evRes = await fetchImpl(`${base}/v1/aers/${opts.aerId}/anchor-evidence`);
  if (evRes.ok) {
    const ev = (await evRes.json()) as AnchorEvidence & { projection_status?: string };
    if (ev && ev.projection_status === 'malformed') anchorEvidenceMalformed = true;
    else anchorEvidence = ev as AnchorEvidence;
  }

  // 4. Verify through the shared core against the BUILTIN trust root (pinned Rekor log
  //    key + pinned AER signing keys). For the PUBLIC verdict the signing key MUST be
  //    pinned: a signature that only checks out against a key served by the very host
  //    under scrutiny proves self-consistency, not trusted AER provenance. An
  //    unpinned-but-mathematically-valid record therefore verifies false (key untrusted)
  //    until its key is added to the trust root; the fetched key is still supplied so
  //    signature_valid is reported honestly for display. The ANCHOR likewise only reaches
  //    `verified` when it chains to a pinned AER key, so a served key can never forge one.
  const trust = opts.trustRoot ?? builtinTrustRoot();
  const res = await verifyAerBundle(bundle, {
    ...(publicKeyHex ? { publicKeyHex } : {}),
    pinnedKeys: trust.aerSigningKeys,
    ...(anchorEvidence ? { anchorEvidence } : {}),
    ...(anchorEvidenceMalformed ? { anchorEvidenceMalformed: true } : {}),
    rekorLogs: trust.rekorLogs,
  });

  const result: VerifyResult = {
    aer_id: bundle.aer_id ?? res.aer_id,
    hash_match: res.checks.hash_match,
    signature_valid: res.checks.signature_valid,
    verified: res.ok,
    anchored: res.checks.anchor.status === 'verified',
    anchor_status: res.checks.anchor.status,
    canonical_hash: res.canonical_hash,
    signing_key_id: res.signing_key_id,
  };
  const reason = keyRes.ok ? legacyReason(res) : `key_not_found: ${keyRes.status}`;
  if (reason !== undefined) result.reason = reason;
  return result;
}
