import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { generateKeyPairSync, sign as nodeCryptoSign, createHash } from 'node:crypto';
import { verifyAer } from './verify.js';
import { canonicalHash, stripIntegrity } from '@aer/schemas';

// Generate a real Ed25519 key pair for the test
const { publicKey: pubKeyObj, privateKey: privKeyObj } = generateKeyPairSync('ed25519');

// Extract raw 32-byte public key from SubjectPublicKeyInfo DER (last 32 bytes)
const pubKeyDer = pubKeyObj.export({ type: 'spki', format: 'der' }) as Buffer;
const pubKeyHex = pubKeyDer.slice(-32).toString('hex');

// The signing key id BINDS to the public key: sha256(rawPubkey)[:16], matching the
// server's derivation. verifyBundleSignature recomputes and asserts this (S3).
const KEY_ID = createHash('sha256').update(pubKeyDer.slice(-32)).digest('hex').slice(0, 16);
// A second, unrelated key whose pubkey does NOT derive to KEY_ID.
const otherPubKeyHex = (generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }) as Buffer).slice(-32).toString('hex');
let keyEndpointPubKeyHex = pubKeyHex;

// Build a minimal but structurally valid AER bundle
function buildBundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = {
    schema_version: '1.0',
    aer_id: '01900000-0000-7000-8000-000000000001',
    tenant_id: '01900000-0000-7000-8000-000000000002',
    agent_id: '01900000-0000-7000-8000-000000000003',
    agent_version: '1.0.0',
    agent_session_id: '01900000-0000-7000-8000-000000000004',
    time_window: { start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T00:01:00.000Z' },
    execution_graph: { nodes: [], edges: [] },
    observations: { events_total: 0, event_type_counts: {} },
    environment_name: 'test',
    ...overrides,
  };
  const hash = canonicalHash(base);
  // Sign raw bytes of hex hash
  const sigB64 = nodeCryptoSign(null, Buffer.from(hash, 'hex'), privKeyObj).toString('base64');
  return {
    ...base,
    integrity: {
      hash,
      signature: sigB64,
      signing_key_id: KEY_ID,
      anchored: false,
    },
  };
}

const AER_ID = '01900000-0000-7000-8000-000000000001';
let currentBundle = buildBundle();

// A trust root that PINS the test key, so the happy path (a validly-signed bundle whose
// key is trusted) reaches verified:true. Without a trust root override the CLI uses the
// builtin root, which does NOT pin this test key — so an otherwise-valid bundle verifies
// FALSE (key untrusted). That is the whole point of blocker 2: a signature that only
// checks out against a server-served key is not trusted provenance.
const TRUST = { aerSigningKeys: [{ signing_key_id: KEY_ID, public_key_hex: pubKeyHex }], rekorLogs: [] };

// Default: no anchor evidence stored (unanchored / pre-anchor). Individual tests
// override this handler when they need to exercise the anchored path.
const server = setupServer(
  http.get('http://test.local/v1/aers/:id/bundle', () => {
    return HttpResponse.json(currentBundle);
  }),
  http.get('http://test.local/v1/keys/:keyId', () => {
    return HttpResponse.json({
      signing_key_id: KEY_ID,
      sig_alg: 'ed25519',
      public_key_hex: keyEndpointPubKeyHex,
    });
  }),
  http.get('http://test.local/v1/aers/:id/anchor-evidence', () => {
    return HttpResponse.json({ error: 'anchor_evidence_unavailable' }, { status: 404 });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

describe('verifyAer', () => {
  it('returns verified=true for a valid bundle signed by a PINNED key', async () => {
    currentBundle = buildBundle();
    const result = await verifyAer({ baseUrl: 'http://test.local', aerId: AER_ID, trustRoot: TRUST });
    expect(result.hash_match).toBe(true);
    expect(result.signature_valid).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.canonical_hash).toBe((currentBundle.integrity as { hash: string }).hash);
  });

  it('verifies FALSE for a mathematically-valid bundle whose key is NOT pinned (blocker 2)', async () => {
    currentBundle = buildBundle();
    // No trustRoot override → the builtin root does not pin this test key.
    const result = await verifyAer({ baseUrl: 'http://test.local', aerId: AER_ID });
    expect(result.hash_match).toBe(true);
    expect(result.signature_valid).toBe(true); // signature is mathematically valid…
    expect(result.verified).toBe(false); // …but the key is untrusted, so the verdict is false
    expect(result.reason).toBe('key_not_pinned');
  });

  it('returns hash_match=false when the bundle is tampered', async () => {
    const tampered = { ...buildBundle() } as Record<string, unknown>;
    // Mutate the bundle without updating integrity
    (tampered as Record<string, unknown>)['agent_version'] = '9.9.9';
    currentBundle = tampered;
    const result = await verifyAer({ baseUrl: 'http://test.local', aerId: AER_ID });
    expect(result.hash_match).toBe(false);
    expect(result.verified).toBe(false);
  });

  it('returns signature_valid=false when integrity.signature is wrong', async () => {
    const bundle = buildBundle();
    // Overwrite signature with random bytes
    (bundle.integrity as Record<string, string>)['signature'] =
      Buffer.from('x'.repeat(64)).toString('base64');
    currentBundle = bundle;
    const result = await verifyAer({ baseUrl: 'http://test.local', aerId: AER_ID });
    // hash should still match (we didn't change the bundle body)
    expect(result.hash_match).toBe(true);
    expect(result.signature_valid).toBe(false);
    expect(result.verified).toBe(false);
  });

  it('rejects a key whose public key does not derive to the claimed signing_key_id (S3 key substitution)', async () => {
    currentBundle = buildBundle();
    // The key endpoint returns a different key's pubkey than the id names.
    keyEndpointPubKeyHex = otherPubKeyHex;
    try {
      const result = await verifyAer({ baseUrl: 'http://test.local', aerId: AER_ID });
      expect(result.verified).toBe(false);
      expect(result.signature_valid).toBe(false);
      expect(result.reason).toBe('key_id_binding_mismatch');
    } finally {
      keyEndpointPubKeyHex = pubKeyHex;
    }
  });

  it('returns key_not_found reason when the key endpoint returns 404', async () => {
    currentBundle = buildBundle();
    server.use(
      http.get('http://test.local/v1/keys/:keyId', () => {
        return HttpResponse.json({ error: 'not_found' }, { status: 404 });
      }),
    );
    const result = await verifyAer({ baseUrl: 'http://test.local', aerId: AER_ID });
    expect(result.signature_valid).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('key_not_found');
    // Reset the handler after this test
    server.resetHandlers();
  });

  it('rejects the bundle fetch correctly', async () => {
    server.use(
      http.get('http://test.local/v1/aers/:id/bundle', () => {
        return HttpResponse.json({ error: 'not_found' }, { status: 404 });
      }),
    );
    await expect(verifyAer({ baseUrl: 'http://test.local', aerId: AER_ID })).rejects.toThrow(
      'failed to fetch bundle',
    );
    server.resetHandlers();
  });

  it('reports the strip-integrity canonical hash in the result', async () => {
    currentBundle = buildBundle();
    const result = await verifyAer({ baseUrl: 'http://test.local', aerId: AER_ID });
    const expected = canonicalHash(stripIntegrity(currentBundle));
    expect(result.canonical_hash).toBe(expected);
  });

  it('reports anchor_status none when the bundle does not claim anchoring', async () => {
    currentBundle = buildBundle({}); // integrity.anchored = false
    const result = await verifyAer({ baseUrl: 'http://test.local', aerId: AER_ID, trustRoot: TRUST });
    expect(result.anchor_status).toBe('none');
    expect(result.anchored).toBe(false);
    expect(result.verified).toBe(true);
  });

  it('reports anchor_status claimed (not verified) when anchoring is claimed but no evidence is served', async () => {
    // A bundle claiming anchored:true whose evidence endpoint 404s (pre-backfill).
    const bundle = buildBundle();
    (bundle.integrity as Record<string, unknown>)['anchored'] = true;
    // Re-sign is unnecessary: integrity.anchored is unsigned display metadata that
    // the verifier reads only as a CLAIM, never trusts.
    currentBundle = bundle;
    const result = await verifyAer({ baseUrl: 'http://test.local', aerId: AER_ID, trustRoot: TRUST });
    expect(result.anchor_status).toBe('claimed');
    expect(result.anchored).toBe(false); // claimed is NOT cryptographically verified
    expect(result.verified).toBe(true); // but the signature merits still hold
  });

  it('reports anchor_status invalid (verified false) when the served evidence is malformed', async () => {
    const bundle = buildBundle();
    (bundle.integrity as Record<string, unknown>)['anchored'] = true;
    currentBundle = bundle;
    // The endpoint reports the stored evidence is present but corrupt.
    server.use(
      http.get('http://test.local/v1/aers/:id/anchor-evidence', () => {
        return HttpResponse.json({ schema_version: 'aer-anchor-evidence.v1', projection_status: 'malformed' });
      }),
    );
    const result = await verifyAer({ baseUrl: 'http://test.local', aerId: AER_ID, trustRoot: TRUST });
    expect(result.anchor_status).toBe('invalid');
    expect(result.anchored).toBe(false);
    expect(result.verified).toBe(false); // corrupt anchor evidence downgrades the verdict
    server.resetHandlers();
  });
});
