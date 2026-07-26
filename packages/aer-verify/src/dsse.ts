// DSSE (Dead Simple Signing Envelope) primitives for AER transparency evidence.
// Ported from the server-side generator; a golden test asserts PAE
// byte-parity with that implementation so envelopes verify identically here.

import { base64ToBytes, utf8 } from './bytes.js';
import type { Ed25519Verify } from './keys.js';

export const ATTESTATION_TYPE = 'application/vnd.aer.attestation+json';
export const ATTESTATION_SCHEMA = 'https://aer.dev/attestation/v1';

export interface AttestationPayload {
  _type: typeof ATTESTATION_SCHEMA;
  aer_id: string;
  canonical_hash: string;
  signing_key_id: string;
  signed_at: string;
}

export interface DsseSignature {
  sig: string; // base64
  keyid?: string;
}

export interface DsseEnvelope {
  payloadType: string;
  payload: string; // base64
  signatures: DsseSignature[];
}

/**
 * DSSE Pre-Authentication Encoding (PAE), per spec:
 *   "DSSEv1" SP LEN(type) SP type SP LEN(payload) SP payload
 * Lengths are ASCII base-10; concatenation is over bytes.
 */
export function paeBytes(payloadType: string, payload: Uint8Array): Uint8Array {
  const typeBytes = utf8(payloadType);
  const prefix = utf8(`DSSEv1 ${typeBytes.length} `);
  const sep = utf8(` ${payload.length} `);
  const out = new Uint8Array(prefix.length + typeBytes.length + sep.length + payload.length);
  let offset = 0;
  out.set(prefix, offset); offset += prefix.length;
  out.set(typeBytes, offset); offset += typeBytes.length;
  out.set(sep, offset); offset += sep.length;
  out.set(payload, offset);
  return out;
}

/**
 * Verify a DSSE envelope against a raw Ed25519 public key. True only if exactly
 * one signature exists and verifies over PAE(payloadType, payload). Uses the
 * injected verifier so it works on every runtime.
 */
export async function verifyDsseEnvelope(
  envelope: DsseEnvelope,
  publicKeyRaw: Uint8Array,
  verify: Ed25519Verify,
): Promise<boolean> {
  if (!envelope.signatures || envelope.signatures.length !== 1) return false;
  let payloadBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    payloadBytes = base64ToBytes(envelope.payload);
    sigBytes = base64ToBytes(envelope.signatures[0]!.sig);
  } catch {
    return false;
  }
  try {
    return await verify(publicKeyRaw, paeBytes(envelope.payloadType, payloadBytes), sigBytes);
  } catch {
    return false;
  }
}

/** Decode an envelope payload back into the attestation object, or null. */
export function decodeAttestation(envelope: DsseEnvelope): AttestationPayload | null {
  if (envelope.payloadType !== ATTESTATION_TYPE) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(base64ToBytes(envelope.payload)));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || (raw as Record<string, unknown>)._type !== ATTESTATION_SCHEMA) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (
    typeof r['aer_id'] !== 'string' ||
    typeof r['canonical_hash'] !== 'string' ||
    typeof r['signing_key_id'] !== 'string' ||
    typeof r['signed_at'] !== 'string'
  ) {
    return null;
  }
  return {
    _type: ATTESTATION_SCHEMA,
    aer_id: r['aer_id'],
    canonical_hash: r['canonical_hash'],
    signing_key_id: r['signing_key_id'],
    signed_at: r['signed_at'],
  };
}
