// DPoP (RFC 9449) proof generation for the collector (Phase 3 M3). A fresh
// Ed25519 keypair is created per AER session and never leaves the process. The
// attestation token is bound to this key (cnf.jkt) at mint; each outbound request
// to a DPoP-enabled protected resource carries a short-lived proof signed by it,
// so a stolen token cannot be replayed from another client.
//
// Self-contained (zero deps): uses node:crypto. Signing is synchronous so the
// node:http patch (which cannot await) can produce a proof inline.

import { generateKeyPairSync, sign as nodeSign, createHash, randomUUID, type KeyObject } from 'node:crypto';

export interface DpopProofArgs {
  method: string;
  url: string;
  /** The attestation token this proof is bound to (its sha256 becomes `ath`). */
  token: string;
  /** Issued-at, epoch seconds. */
  nowSec: number;
}

export interface DpopKey {
  /** RFC 7638 thumbprint of the public key — sent as `dpop_jkt` at mint. */
  readonly jkt: string;
  /** Sign a DPoP proof JWT for one request. Synchronous. */
  proof(args: DpopProofArgs): string;
}

/** Create a per-session DPoP key (ephemeral Ed25519, held only in memory). */
export function createDpopKey(): DpopKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const x = bytesToB64url(extractRawEd25519PublicKey(publicKey));
  const jwk = { kty: 'OKP' as const, crv: 'Ed25519' as const, x };
  const jkt = createHash('sha256').update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest('base64url');

  return {
    jkt,
    proof({ method, url, token, nowSec }): string {
      const header = { typ: 'dpop+jwt', alg: 'EdDSA', jwk };
      const claims = {
        htm: method.toUpperCase(),
        htu: normalizeHtu(url),
        iat: nowSec,
        jti: randomUUID(),
        ath: createHash('sha256').update(token).digest('base64url'),
      };
      const input = `${b64urlJson(header)}.${b64urlJson(claims)}`;
      const sig = nodeSign(null, Buffer.from(input), privateKey);
      return `${input}.${bytesToB64url(sig)}`;
    },
  };
}

/** Normalize an HTTP target URI for the htu claim (drop query/fragment, lowercase, strip default port). */
export function normalizeHtu(url: string): string {
  const u = new URL(url);
  const port = u.port ? `:${u.port}` : '';
  return `${u.protocol.toLowerCase()}//${u.hostname.toLowerCase()}${port}${u.pathname}`;
}

// Ed25519 SPKI DER is a 12-byte envelope + the 32-byte raw key.
function extractRawEd25519PublicKey(key: KeyObject): Uint8Array {
  const spki = key.export({ type: 'spki', format: 'der' }) as Buffer;
  return spki.subarray(spki.length - 32);
}

function b64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function bytesToB64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}
