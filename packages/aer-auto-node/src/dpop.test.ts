import { describe, it, expect } from 'vitest';
import { createHash, verify as nodeVerify, createPublicKey } from 'node:crypto';
import { createDpopKey, normalizeHtu } from './dpop.js';

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

// Verify an Ed25519 signature over `${h}.${p}` using the raw public key in the jwk.
function verifyProofSig(proof: string): boolean {
  const [h, p, s] = proof.split('.');
  const header = decode(h!) as { jwk: { x: string } };
  const raw = Buffer.from(header.jwk.x, 'base64url');
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') } as never, format: 'jwk' });
  return nodeVerify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s!, 'base64url'));
}

describe('normalizeHtu', () => {
  it('drops query/fragment, lowercases, strips default port', () => {
    expect(normalizeHtu('HTTPS://MCP.Example:443/mcp?a=1#f')).toBe('https://mcp.example/mcp');
    expect(normalizeHtu('https://h:8443/x')).toBe('https://h:8443/x');
  });
});

describe('createDpopKey', () => {
  it('exposes a stable 43-char base64url thumbprint', () => {
    const k = createDpopKey();
    expect(k.jkt).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(k.jkt).toBe(k.jkt); // stable across reads
  });

  it('two keys have different thumbprints', () => {
    expect(createDpopKey().jkt).not.toBe(createDpopKey().jkt);
  });

  it('signs a verifiable proof JWT with the expected claims', () => {
    const k = createDpopKey();
    const token = 'the-attestation-token';
    const proof = k.proof({ method: 'post', url: 'https://mcp.example/mcp?x=1', token, nowSec: 1_750_000_000 });

    const [h, p] = proof.split('.');
    expect(decode(h!)).toMatchObject({ typ: 'dpop+jwt', alg: 'EdDSA', jwk: { kty: 'OKP', crv: 'Ed25519' } });
    const claims = decode(p!);
    expect(claims['htm']).toBe('POST'); // upper-cased
    expect(claims['htu']).toBe('https://mcp.example/mcp'); // normalized
    expect(claims['iat']).toBe(1_750_000_000);
    expect(claims['ath']).toBe(createHash('sha256').update(token).digest('base64url'));
    expect(String(claims['jti'])).toHaveLength(36); // uuid
    expect(verifyProofSig(proof)).toBe(true);
  });

  it('a tampered proof body fails signature verification', () => {
    const k = createDpopKey();
    const proof = k.proof({ method: 'GET', url: 'https://h/x', token: 't', nowSec: 1 });
    const [h, , s] = proof.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ htm: 'GET', htu: 'https://h/evil', iat: 1, jti: 'x', ath: 'y' })).toString('base64url')}.${s}`;
    expect(verifyProofSig(forged)).toBe(false);
  });

  it('each proof has a unique jti', () => {
    const k = createDpopKey();
    const a = decode(k.proof({ method: 'GET', url: 'https://h/x', token: 't', nowSec: 1 }).split('.')[1]!);
    const b = decode(k.proof({ method: 'GET', url: 'https://h/x', token: 't', nowSec: 1 }).split('.')[1]!);
    expect(a['jti']).not.toBe(b['jti']);
  });
});
