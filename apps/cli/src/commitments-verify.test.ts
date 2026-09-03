import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalHash, stripIntegrity } from '@aer/schemas';
import {
  verifyCommitments,
  runCommitmentsVerify,
  parseCommitmentsVerifyArgs,
} from './commitments-verify.js';
import {
  commitmentKeyFromString,
  canonicalizeRequest,
  promptCanonTag,
  wireBodyTag,
  deriveKid,
} from '@adastracomputing/aer-auto-node/commitment';

const KEY_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const KEY = commitmentKeyFromString(KEY_HEX)!;
const OTHER_KEY_HEX = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

// The plaintext the customer retained. Its distinctive content must never appear
// in any verifier output (no-plaintext discipline).
const REQUEST = { model: 'gpt-4o', messages: [{ role: 'user', content: 'SECRETprompt weather?' }] };

function commitmentFor(key: Buffer, req: unknown, ref = 'r1') {
  const canon = canonicalizeRequest('openai', [req])!;
  return {
    request_ref: ref,
    kid: deriveKid(key),
    canon: 'aer-canon.v1',
    prompt_canon_tag: promptCanonTag(key, canon),
    wire: { canon: 'aer-wire.v1', tag: wireBodyTag(key, req) },
  };
}

function unsignedBundle(commitments: unknown[]) {
  return { aer_id: 'aer-1', content_commitments: commitments };
}

// Sign a bundle with a fresh Ed25519 key, matching the server scheme the CLI
// verifier checks (Ed25519 over the raw bytes of the canonical hash hex, base64).
async function signBundle(bundle: Record<string, unknown>) {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const hash = canonicalHash(stripIntegrity(bundle));
  const sig = await crypto.subtle.sign('Ed25519', pair.privateKey, Buffer.from(hash, 'hex'));
  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  // The signing_key_id must BIND to the public key (sha256(rawPub)[:16]), the same
  // derivation the server signs with, or the S3 key-id binding check rejects it.
  const kid = createHash('sha256').update(rawPub).digest('hex').slice(0, 16);
  const signed = { ...bundle, integrity: { hash, signature: Buffer.from(sig).toString('base64'), signing_key_id: kid, anchored: false } };
  const publicKeyHex = Buffer.from(rawPub).toString('hex');
  return { signed, publicKeyHex, kid };
}

describe('verifyCommitments (pure)', () => {
  it('opens a commitment when the bundle is verified and key + plaintext match', () => {
    const res = verifyCommitments(unsignedBundle([commitmentFor(KEY, REQUEST)]), KEY, [{ provider: 'openai', request: REQUEST }], true);
    expect(res.bundle_verified).toBe(true);
    expect(res.all_matched).toBe(true);
    expect(res.key_kid_matches_bundle).toBe(true);
    expect(res.results[0]!.matched).toBe(true);
    expect(res.results[0]!.request_ref).toBe('r1');
    expect(res.results[0]!.wire_matched).toBe(true);
  });

  it('fails closed: an UNVERIFIED bundle never reports a match even with the right key/plaintext', () => {
    const res = verifyCommitments(unsignedBundle([commitmentFor(KEY, REQUEST)]), KEY, [{ provider: 'openai', request: REQUEST }], false);
    expect(res.bundle_verified).toBe(false);
    expect(res.all_matched).toBe(false);
    expect(res.results[0]!.matched).toBe(false);
    expect(res.results[0]!.reason).toMatch(/did not verify/);
  });

  it('fails to match on the wrong key (kid mismatch)', () => {
    const wrong = commitmentKeyFromString(OTHER_KEY_HEX)!;
    const res = verifyCommitments(unsignedBundle([commitmentFor(KEY, REQUEST)]), wrong, [{ provider: 'openai', request: REQUEST }], true);
    expect(res.key_kid_matches_bundle).toBe(false);
    expect(res.results[0]!.matched).toBe(false);
  });

  it('fails to match when the plaintext differs from what was committed', () => {
    const tampered = { model: 'gpt-4o', messages: [{ role: 'user', content: 'sunny?' }] };
    const res = verifyCommitments(unsignedBundle([commitmentFor(KEY, REQUEST)]), KEY, [{ provider: 'openai', request: tampered }], true);
    expect(res.results[0]!.matched).toBe(false);
  });

  it('reports wire_matched=null when the commitment carries no wire tag', () => {
    const c = commitmentFor(KEY, REQUEST) as { wire?: unknown };
    delete c.wire;
    const res = verifyCommitments(unsignedBundle([c]), KEY, [{ provider: 'openai', request: REQUEST }], true);
    expect(res.results[0]!.matched).toBe(true);
    expect(res.results[0]!.wire_matched).toBeNull();
  });

  it('flags an uncanonicalizable request rather than crashing', () => {
    const res = verifyCommitments(unsignedBundle([commitmentFor(KEY, REQUEST)]), KEY, [{ provider: 'bogus', request: REQUEST }], true);
    expect(res.results[0]!.prompt_canon_tag).toBeNull();
    expect(res.results[0]!.matched).toBe(false);
    expect(res.results[0]!.reason).toBeDefined();
  });

  it('reports ambiguous (no request_ref) when the prompt tag matches multiple commitments and wire cannot disambiguate', () => {
    // Two commitments, same prompt tag, neither with a wire tag → ambiguous.
    const a = commitmentFor(KEY, REQUEST, 'rA') as { wire?: unknown };
    const b = commitmentFor(KEY, REQUEST, 'rB') as { wire?: unknown };
    delete a.wire; delete b.wire;
    const res = verifyCommitments(unsignedBundle([a, b]), KEY, [{ provider: 'openai', request: REQUEST }], true);
    expect(res.results[0]!.matched).toBe(true);
    expect(res.results[0]!.ambiguous).toBe(true);
    expect(res.results[0]!.request_ref).toBeNull();
  });

  it('never emits the plaintext — output is tags, booleans and the opaque ref only', () => {
    const res = verifyCommitments(unsignedBundle([commitmentFor(KEY, REQUEST)]), KEY, [{ provider: 'openai', request: REQUEST }], true);
    expect(JSON.stringify(res)).not.toContain('SECRETprompt');
  });
});

describe('parseCommitmentsVerifyArgs', () => {
  it('parses --aer / --bundle / --requests', () => {
    expect(parseCommitmentsVerifyArgs(['--aer', 'x', '--requests', 'r.json'])).toEqual({ aerId: 'x', requestsPath: 'r.json' });
    expect(parseCommitmentsVerifyArgs(['--bundle', 'b.json', '--requests', 'r.json'])).toEqual({ bundlePath: 'b.json', requestsPath: 'r.json' });
  });
});

describe('runCommitmentsVerify (runner)', () => {
  const REQS = JSON.stringify([{ provider: 'openai', request: REQUEST }]);

  it('verifies the signature, then opens the commitment — exit 0', async () => {
    const { signed, publicKeyHex, kid } = await signBundle(unsignedBundle([commitmentFor(KEY, REQUEST)]));
    const files: Record<string, string> = { 'reqs.json': REQS, 'bundle.json': JSON.stringify(signed) };
    const fetchImpl = (async (url: string) => {
      // Only the public signing key is fetched (public, not a secret), by its id.
      expect(String(url)).toContain(`/v1/keys/${kid}`);
      return new Response(JSON.stringify({ signing_key_id: kid, sig_alg: 'Ed25519', public_key_hex: publicKeyHex }), { status: 200 });
    }) as unknown as typeof fetch;
    // Same as `aer verify`: the signing key must be PINNED for verified:true.
    // Without a trust root override the builtin root doesn't know this
    // test-generated key, so the CLI's default fail-closed behavior applies.
    const trustRoot = { aerSigningKeys: [{ signing_key_id: kid, public_key_hex: publicKeyHex }], rekorLogs: [] };
    const { result, exitCode } = await runCommitmentsVerify(
      ['--requests', 'reqs.json', '--bundle', 'bundle.json'],
      { baseUrl: 'https://api.test', commitmentKey: KEY_HEX, readFile: async (p) => files[p]!, fetchImpl, trustRoot },
    );
    expect(result.bundle_verified).toBe(true);
    expect(result.bundle_signature?.signature_valid).toBe(true);
    expect(result.all_matched).toBe(true);
    expect(exitCode).toBe(0);
  });

  it('fails closed on an UNSIGNED bundle: exit 1, bundle_verified false, no match', async () => {
    const files: Record<string, string> = { 'reqs.json': REQS, 'bundle.json': JSON.stringify(unsignedBundle([commitmentFor(KEY, REQUEST)])) };
    const fetchImpl = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch;
    const { result, exitCode } = await runCommitmentsVerify(
      ['--requests', 'reqs.json', '--bundle', 'bundle.json'],
      { baseUrl: 'https://api.test', commitmentKey: KEY_HEX, readFile: async (p) => files[p]!, fetchImpl },
    );
    expect(result.bundle_verified).toBe(false);
    expect(result.all_matched).toBe(false);
    expect(result.results[0]!.matched).toBe(false);
    expect(exitCode).toBe(1);
  });

  it('fetches the bundle by --aer when no local bundle is given', async () => {
    const { signed, publicKeyHex, kid } = await signBundle(unsignedBundle([commitmentFor(KEY, REQUEST)]));
    const fetchImpl = (async (url: string) => {
      const u = String(url);
      if (u.includes('/v1/aers/aer-9/bundle')) return new Response(JSON.stringify(signed), { status: 200 });
      return new Response(JSON.stringify({ signing_key_id: kid, sig_alg: 'Ed25519', public_key_hex: publicKeyHex }), { status: 200 });
    }) as unknown as typeof fetch;
    const trustRoot = { aerSigningKeys: [{ signing_key_id: kid, public_key_hex: publicKeyHex }], rekorLogs: [] };
    const { result } = await runCommitmentsVerify(
      ['--requests', 'reqs.json', '--aer', 'aer-9'],
      { baseUrl: 'https://api.test', commitmentKey: KEY_HEX, readFile: async () => REQS, fetchImpl, trustRoot },
    );
    expect(result.all_matched).toBe(true);
  });

  it('fails with the SAME key_not_pinned reason as `aer verify` for a mathematically-valid signature under an unpinned key (blocker parity)', async () => {
    const { signed, publicKeyHex, kid } = await signBundle(unsignedBundle([commitmentFor(KEY, REQUEST)]));
    const files: Record<string, string> = { 'reqs.json': REQS, 'bundle.json': JSON.stringify(signed) };
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ signing_key_id: kid, sig_alg: 'Ed25519', public_key_hex: publicKeyHex }), { status: 200 })
    ) as unknown as typeof fetch;
    // No trustRoot override → falls back to the builtin root, which does not pin
    // this freshly-generated test key. Mirrors verify.test.ts's blocker-2 case.
    const { result, exitCode } = await runCommitmentsVerify(
      ['--requests', 'reqs.json', '--bundle', 'bundle.json'],
      { baseUrl: 'https://api.test', commitmentKey: KEY_HEX, readFile: async (p) => files[p]!, fetchImpl },
    );
    expect(result.bundle_signature?.signature_valid).toBe(true); // mathematically valid…
    expect(result.bundle_signature?.reason).toBe('key_not_pinned'); // …but untrusted, same as `aer verify`
    expect(result.bundle_verified).toBe(false);
    expect(result.all_matched).toBe(false);
    expect(exitCode).toBe(1);
  });

  it('throws (no partial output) when the key is missing', async () => {
    await expect(
      runCommitmentsVerify(['--requests', 'reqs.json', '--bundle', 'bundle.json'], { baseUrl: 'https://api.test', readFile: async () => REQS }),
    ).rejects.toThrow(/AER_COMMITMENT_KEY/);
  });

  it('throws when neither --aer nor --bundle is provided', async () => {
    await expect(
      runCommitmentsVerify(['--requests', 'reqs.json'], { baseUrl: 'https://api.test', commitmentKey: KEY_HEX, readFile: async () => REQS }),
    ).rejects.toThrow(/--aer|--bundle/);
  });
});
