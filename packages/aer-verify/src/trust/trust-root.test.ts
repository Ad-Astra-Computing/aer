import { describe, it, expect } from 'vitest';
import { builtinTrustRoot, loadTrustRoot } from './trust-root.js';
import { verifyCheckpoint } from '../rekor/checkpoint.js';
import { signingKeyIdFromPublicKeyHex } from '../keys.js';
import { REKOR_V1_CHECKPOINT, REKOR_V1_NAME } from '../rekor/fixtures.js';

describe('builtin trust root', () => {
  it('pins the Rekor v1 log key and verifies a real checkpoint with it', async () => {
    const root = builtinTrustRoot();
    expect(root.rekorLogs).toHaveLength(1);
    expect(root.rekorLogs[0]!.name).toBe(REKOR_V1_NAME);
    const res = await verifyCheckpoint(REKOR_V1_CHECKPOINT, root.rekorLogs);
    expect(res.valid).toBe(true);
  });

  it('pins the platform AER signing keys, each self-authenticating', async () => {
    const keys = builtinTrustRoot().aerSigningKeys;
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(await signingKeyIdFromPublicKeyHex(k.public_key_hex)).toBe(k.signing_key_id.toLowerCase());
    }
    expect(keys.map((k) => k.signing_key_id)).toContain('a721bb9bd8f31c8e');
  });
});

describe('loadTrustRoot', () => {
  const good = {
    version: 2,
    aerSigningKeys: [{ signing_key_id: 'a721bb9bd8f31c8e', public_key_hex: 'ab'.repeat(32) }],
    rekorLogs: [
      { name: 'rekor.sigstore.dev', spki_b64: 'AAAA', algorithm: 'ecdsa-p256' },
    ],
    expiresAt: '2099-01-01T00:00:00Z',
  };

  it('parses a well-formed document', () => {
    const r = loadTrustRoot(good, { now: Date.parse('2026-07-20T00:00:00Z') });
    expect(r.version).toBe(2);
    expect(r.aerSigningKeys[0]!.signing_key_id).toBe('a721bb9bd8f31c8e');
    expect(r.rekorLogs[0]!.algorithm).toBe('ecdsa-p256');
  });

  it('rejects an expired root', () => {
    expect(() =>
      loadTrustRoot({ ...good, expiresAt: '2020-01-01T00:00:00Z' }, {
        now: Date.parse('2026-07-20T00:00:00Z'),
      }),
    ).toThrow(/expired/);
  });

  it('rejects a bad version', () => {
    expect(() => loadTrustRoot({ ...good, version: 0 })).toThrow(/version/);
  });

  it('rejects an unsupported rekor algorithm', () => {
    expect(() =>
      loadTrustRoot({ ...good, rekorLogs: [{ name: 'x', spki_b64: 'AAAA', algorithm: 'rsa' }] }),
    ).toThrow(/algorithm/);
  });

  it('rejects a malformed AER key entry', () => {
    expect(() =>
      loadTrustRoot({ ...good, aerSigningKeys: [{ signing_key_id: 'x' }] }),
    ).toThrow(/malformed/);
  });

  it('defaults empty key sets when omitted', () => {
    const r = loadTrustRoot({ version: 1 });
    expect(r.aerSigningKeys).toEqual([]);
    expect(r.rekorLogs).toEqual([]);
  });
});
