// Pure crypto/JOSE helpers the resource-node and mcp-guard test suites need to
// mint AER attestation tokens and DPoP proofs. Self-contained private package so
// the client tests can run without pulling in any control-plane code. Nothing
// below touches a database, object store, config or tenancy.

import {
  createHash,
  generateKeyPairSync,
  sign as nodeSign,
  type KeyObject,
} from 'node:crypto';

// ── Ed25519 signer ────────────────────────────────────────────────────────────

export interface Signer {
  sign(digest: Uint8Array): Promise<Uint8Array>;
  publicKey(): Uint8Array;
}

export function createInMemorySigner(): Signer {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return keyObjectSigner(privateKey, publicKey);
}

function keyObjectSigner(privateKey: KeyObject, publicKey: KeyObject): Signer {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const rawKeyBytes = extractRawEd25519PublicKey(spki);
  return {
    async sign(digest: Uint8Array): Promise<Uint8Array> {
      return nodeSign(null, digest, privateKey);
    },
    publicKey(): Uint8Array {
      return rawKeyBytes;
    },
  };
}

/** Short signing-key id: first 16 hex chars of sha256(raw public key). */
export function signingKeyIdFromPublicKey(publicKeyRaw: Uint8Array): string {
  return createHash('sha256').update(publicKeyRaw).digest('hex').slice(0, 16);
}

// Ed25519 SPKI DER is a 12-byte ASN.1 envelope then the 32-byte raw public key.
function extractRawEd25519PublicKey(spki: Buffer): Uint8Array {
  if (spki.length < 32) {
    throw new Error(`unexpected SPKI length ${spki.length}, need at least 32`);
  }
  return spki.subarray(spki.length - 32);
}

// ── Attestation signer (raw-message Ed25519) ────────────────────────────────────

export interface AttestationSigner {
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  publicKey(): Uint8Array;
}

export function createInMemoryAttestationSigner(): AttestationSigner {
  const s = createInMemorySigner();
  return { signMessage: (m) => s.sign(m), publicKey: () => s.publicKey() };
}

// ── Attestation JWT ─────────────────────────────────────────────────────────────

export const ATTESTATION_TYP = 'aer-attestation+jwt';

export interface AttestationClaims {
  iss: string;
  aud: string;
  sub: string;
  tenant_id: string;
  agent_id: string;
  agent_session_id: string;
  environment_id: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  scp?: string[];
  cnf?: { jkt?: string; 'x5t#S256'?: string };
}

export interface Jwk {
  kty: 'OKP';
  crv: 'Ed25519';
  use: 'sig';
  alg: 'EdDSA';
  kid: string;
  x: string; // base64url raw public key
}

interface AttestationHeader {
  alg: string;
  typ: string;
  kid: string;
}

export async function signAttestationJwt(
  signer: AttestationSigner,
  kid: string,
  claims: AttestationClaims,
): Promise<string> {
  const header: AttestationHeader = { alg: 'EdDSA', typ: ATTESTATION_TYP, kid };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const sig = await signer.signMessage(new TextEncoder().encode(signingInput));
  return `${signingInput}.${bytesToB64url(sig)}`;
}

// ── DPoP (RFC 9449) ─────────────────────────────────────────────────────────────

export const DPOP_TYP = 'dpop+jwt';

export interface DpopJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string; // base64url raw public key
}

export interface DpopProofClaims {
  htm: string;
  htu: string;
  iat: number;
  jti: string;
  ath: string;
}

interface DpopHeader {
  typ: string;
  alg: string;
  jwk: DpopJwk;
}

/** RFC 7638 JWK thumbprint of an OKP/Ed25519 public key. */
export function jwkThumbprint(jwk: DpopJwk): string {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`;
  return createHash('sha256').update(canonical).digest('base64url');
}

/** Thumbprint from a raw 32-byte Ed25519 public key. */
export function jwkThumbprintFromPublicKey(pub: Uint8Array): string {
  return jwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x: Buffer.from(pub).toString('base64url') });
}

/** ath claim: base64url(sha256(ASCII(attestation token))). */
export function attestationThumbprint(attestationToken: string): string {
  return createHash('sha256').update(attestationToken).digest('base64url');
}

/** Sign a DPoP proof JWT with the session Ed25519 signer (public key embedded as jwk). */
export async function signDpopProof(signer: Signer, claims: DpopProofClaims): Promise<string> {
  const jwk: DpopJwk = { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(signer.publicKey()).toString('base64url') };
  const header: DpopHeader = { typ: DPOP_TYP, alg: 'EdDSA', jwk };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const sig = await signer.sign(new TextEncoder().encode(signingInput));
  return `${signingInput}.${bytesToB64url(sig)}`;
}

// ── base64url helpers ───────────────────────────────────────────────────────────

function b64urlJson(obj: unknown): string {
  return bytesToB64url(new TextEncoder().encode(JSON.stringify(obj)));
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export * from './dsse.js';

export {
  HOSTILE_OBJECTS,
  HOSTILE_STRINGS,
  answersRatherThanCrashes,
} from './hostile-input.js';
