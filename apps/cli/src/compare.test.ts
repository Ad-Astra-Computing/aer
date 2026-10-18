import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalHash, stripIntegrity } from '@aer/schemas';
import { parseCompareArgs, runCompare } from './compare.js';

const TAG_1 = 'a'.repeat(64);
const TAG_2 = 'b'.repeat(64);
const KID = '1'.repeat(16);

function commitment(overrides: Record<string, unknown> = {}) {
  return {
    request_ref: 'r1',
    provider: 'openai',
    model: 'gpt-4o',
    kid: KID,
    canon: 'aer-canon.v1',
    capture_point: 'adapter_request',
    prompt_canon_tag: TAG_1,
    outcome: 'ok',
    message_count: 1,
    prompt_bytes: 10,
    retained: 'none',
    at: '2026-10-18T00:00:00.000Z',
    ...overrides,
  };
}

function bundle(aerId: string, overrides: Record<string, unknown> = {}) {
  return {
    aer_id: aerId,
    content_commitments: [commitment()],
    execution_graph: { nodes: [{ type: 'llm.requested' }], edges: [] },
    observations: { domains_contacted: [], tools_used: [], files_touched: [], processes_spawned: [] },
    ...overrides,
  };
}

// Mirrors commitments-verify.test.ts's signBundle: a real Ed25519 signature over
// the canonical hash, with a signing_key_id that binds to the public key the way
// the server does.
async function signBundle(b: Record<string, unknown>) {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const hash = canonicalHash(stripIntegrity(b));
  const sig = await crypto.subtle.sign('Ed25519', pair.privateKey, Buffer.from(hash, 'hex'));
  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const kid = createHash('sha256').update(rawPub).digest('hex').slice(0, 16);
  const signed = { ...b, integrity: { hash, signature: Buffer.from(sig).toString('base64'), signing_key_id: kid, anchored: false } };
  const publicKeyHex = Buffer.from(rawPub).toString('hex');
  return { signed, publicKeyHex, kid };
}

describe('parseCompareArgs', () => {
  it('reads two positional AER ids', () => {
    expect(parseCompareArgs(['aer-a', 'aer-b'])).toEqual({ aerA: 'aer-a', aerB: 'aer-b' });
  });

  it('reads --bundle-a/--bundle-b file paths', () => {
    expect(parseCompareArgs(['--bundle-a', 'a.json', '--bundle-b', 'b.json'])).toEqual({
      bundlePathA: 'a.json',
      bundlePathB: 'b.json',
    });
  });

  it('mixes one positional id with one bundle file', () => {
    expect(parseCompareArgs(['aer-a', '--bundle-b', 'b.json'])).toEqual({
      aerA: 'aer-a',
      bundlePathB: 'b.json',
    });
  });

  it('rejects an unknown flag rather than silently dropping it', () => {
    expect(() => parseCompareArgs(['aer-a', 'aer-b', '--json'])).toThrow(/unknown flag: --json/);
  });

  it('rejects --bundle-a with no value rather than silently dropping it', () => {
    expect(() => parseCompareArgs(['--bundle-a'])).toThrow(/requires a value/);
  });

  it('rejects a third positional id rather than silently dropping it', () => {
    expect(() => parseCompareArgs(['aer-a', 'aer-b', 'aer-c'])).toThrow(/too many arguments/);
  });
});

describe('runCompare', () => {
  it('verifies both signatures, compares, exits 0 on identical bundles', async () => {
    const a = await signBundle(bundle('aer-a'));
    const b = await signBundle(bundle('aer-b'));
    const files: Record<string, string> = { 'a.json': JSON.stringify(a.signed), 'b.json': JSON.stringify(b.signed) };
    const fetchImpl = (async (url: string) => {
      const u = String(url);
      if (u.includes(a.kid)) return new Response(JSON.stringify({ signing_key_id: a.kid, sig_alg: 'Ed25519', public_key_hex: a.publicKeyHex }), { status: 200 });
      if (u.includes(b.kid)) return new Response(JSON.stringify({ signing_key_id: b.kid, sig_alg: 'Ed25519', public_key_hex: b.publicKeyHex }), { status: 200 });
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
    const trustRoot = {
      aerSigningKeys: [
        { signing_key_id: a.kid, public_key_hex: a.publicKeyHex },
        { signing_key_id: b.kid, public_key_hex: b.publicKeyHex },
      ],
      rekorLogs: [],
    };
    const { result, exitCode } = await runCompare(
      ['--bundle-a', 'a.json', '--bundle-b', 'b.json'],
      { baseUrl: 'https://api.test', readFile: async (p) => files[p]!, fetchImpl, trustRoot },
    );
    expect(result.bundle_a_verified).toBe(true);
    expect(result.bundle_b_verified).toBe(true);
    expect(result.comparison?.comparable).toBe(true);
    expect(result.comparison?.prompts.identical).toBe(true);
    expect(exitCode).toBe(0);
  });

  it('fails closed: an UNSIGNED bundle on either side never produces a comparison, exit 1', async () => {
    const files: Record<string, string> = {
      'a.json': JSON.stringify(bundle('aer-a')), // no integrity block
      'b.json': JSON.stringify((await signBundle(bundle('aer-b'))).signed),
    };
    const fetchImpl = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch;
    const { result, exitCode } = await runCompare(
      ['--bundle-a', 'a.json', '--bundle-b', 'b.json'],
      { readFile: async (p) => files[p]!, fetchImpl },
    );
    expect(result.bundle_a_verified).toBe(false);
    expect(result.comparison).toBeNull();
    expect(result.reason).toBe('bundle_signature_unverified');
    expect(exitCode).toBe(1);
  });

  it('exits 1 and reports the divergence index when prompts differ, even with both signatures valid', async () => {
    const a = await signBundle(bundle('aer-a'));
    const b = await signBundle(bundle('aer-b', { content_commitments: [commitment({ prompt_canon_tag: TAG_2 })] }));
    const files: Record<string, string> = { 'a.json': JSON.stringify(a.signed), 'b.json': JSON.stringify(b.signed) };
    const fetchImpl = (async (url: string) => {
      const u = String(url);
      if (u.includes(a.kid)) return new Response(JSON.stringify({ signing_key_id: a.kid, sig_alg: 'Ed25519', public_key_hex: a.publicKeyHex }), { status: 200 });
      if (u.includes(b.kid)) return new Response(JSON.stringify({ signing_key_id: b.kid, sig_alg: 'Ed25519', public_key_hex: b.publicKeyHex }), { status: 200 });
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
    const trustRoot = {
      aerSigningKeys: [
        { signing_key_id: a.kid, public_key_hex: a.publicKeyHex },
        { signing_key_id: b.kid, public_key_hex: b.publicKeyHex },
      ],
      rekorLogs: [],
    };
    const { result, exitCode } = await runCompare(
      ['--bundle-a', 'a.json', '--bundle-b', 'b.json'],
      { baseUrl: 'https://api.test', readFile: async (p) => files[p]!, fetchImpl, trustRoot },
    );
    expect(result.comparison?.prompts.identical).toBe(false);
    expect(result.comparison?.prompts.first_divergence).toBe(0);
    expect(exitCode).toBe(1);
  });

  it('fetches both bundles by id when no local file is given', async () => {
    const a = await signBundle(bundle('aer-a'));
    const b = await signBundle(bundle('aer-b'));
    const fetchImpl = (async (url: string) => {
      const u = String(url);
      if (u.includes('/v1/aers/aer-a/bundle')) return new Response(JSON.stringify(a.signed), { status: 200 });
      if (u.includes('/v1/aers/aer-b/bundle')) return new Response(JSON.stringify(b.signed), { status: 200 });
      if (u.includes(a.kid)) return new Response(JSON.stringify({ signing_key_id: a.kid, sig_alg: 'Ed25519', public_key_hex: a.publicKeyHex }), { status: 200 });
      if (u.includes(b.kid)) return new Response(JSON.stringify({ signing_key_id: b.kid, sig_alg: 'Ed25519', public_key_hex: b.publicKeyHex }), { status: 200 });
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
    const trustRoot = {
      aerSigningKeys: [
        { signing_key_id: a.kid, public_key_hex: a.publicKeyHex },
        { signing_key_id: b.kid, public_key_hex: b.publicKeyHex },
      ],
      rekorLogs: [],
    };
    const { result, exitCode } = await runCompare(
      ['aer-a', 'aer-b'],
      { baseUrl: 'https://api.test', fetchImpl, trustRoot },
    );
    expect(result.aer_a).toBe('aer-a');
    expect(result.aer_b).toBe('aer-b');
    expect(exitCode).toBe(0);
  });

  it('rejects when fewer than two bundle sources are given', async () => {
    await expect(runCompare(['aer-a'], {})).rejects.toThrow(/usage: aer compare/);
  });

  it('never leaks a secret planted in a non-id bundle field, through the full CLI path', async () => {
    const SECRET = 'SECRET-prompt-text-must-never-appear-anywhere';
    const a = await signBundle(bundle('aer-a', { content_commitments: [commitment({ request_ref: SECRET, prompt: SECRET })] }));
    const b = await signBundle(bundle('aer-b'));
    const files: Record<string, string> = { 'a.json': JSON.stringify(a.signed), 'b.json': JSON.stringify(b.signed) };
    const fetchImpl = (async (url: string) => {
      const u = String(url);
      if (u.includes(a.kid)) return new Response(JSON.stringify({ signing_key_id: a.kid, sig_alg: 'Ed25519', public_key_hex: a.publicKeyHex }), { status: 200 });
      if (u.includes(b.kid)) return new Response(JSON.stringify({ signing_key_id: b.kid, sig_alg: 'Ed25519', public_key_hex: b.publicKeyHex }), { status: 200 });
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
    const trustRoot = {
      aerSigningKeys: [
        { signing_key_id: a.kid, public_key_hex: a.publicKeyHex },
        { signing_key_id: b.kid, public_key_hex: b.publicKeyHex },
      ],
      rekorLogs: [],
    };
    const { result } = await runCompare(
      ['--bundle-a', 'a.json', '--bundle-b', 'b.json'],
      { baseUrl: 'https://api.test', readFile: async (p) => files[p]!, fetchImpl, trustRoot },
    );
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
