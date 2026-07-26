// DSSE reference helpers for the aer-verify parity suite. Mirrors the server
// generator's envelope construction so the client verifier can assert byte
// parity against a known-good reference. Test-only, never published.
import type { Signer } from './index.js';

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

// DSSE Pre-Authentication Encoding: "DSSEv1 <len(type)> <type> <len(payload)> <payload>"
export function paeBytes(payloadType: string, payload: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const typeBytes = enc.encode(payloadType);
  const prefix = enc.encode(`DSSEv1 ${typeBytes.length} `);
  const sep1 = enc.encode(` ${payload.length} `);
  const out = new Uint8Array(
    prefix.length + typeBytes.length + sep1.length + payload.length,
  );
  let offset = 0;
  out.set(prefix, offset);
  offset += prefix.length;
  out.set(typeBytes, offset);
  offset += typeBytes.length;
  out.set(sep1, offset);
  offset += sep1.length;
  out.set(payload, offset);
  return out;
}

export async function buildDsseEnvelope(
  attestation: AttestationPayload,
  signer: Signer,
): Promise<DsseEnvelope> {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(attestation));
  const pae = paeBytes(ATTESTATION_TYPE, payloadBytes);
  const sig = await signer.sign(pae);
  return {
    payloadType: ATTESTATION_TYPE,
    payload: Buffer.from(payloadBytes).toString('base64'),
    signatures: [{ sig: Buffer.from(sig).toString('base64') }],
  };
}
