// @adastracomputing/aer-mcp-guard - admission control for HTTP MCP servers (ADR-010 2d).
//
// Wraps an HTTP-based MCP endpoint (Streamable HTTP or SSE) so only AER-attested
// agents reach it. A rogue agent presents no token and is denied with a JSON-RPC
// 2.0 error. Built on @adastracomputing/aer-resource-node (offline verify + optional
// introspection); NO dependency on @modelcontextprotocol/sdk - mount it in front
// of any MCP HTTP handler. `stdio` MCP is out of scope (no network admission
// point); only HTTP transports are guarded.

import {
  verifyAttestation,
  readAttestationHeader,
  AttestationError,
  thumbprintFromPeerCert,
  thumbprintFromForwardedClientCert,
  type VerifyOptions,
  type AttestationClaims,
} from '@adastracomputing/aer-resource-node';

export { AttestationError, thumbprintFromPeerCert, thumbprintFromForwardedClientCert };
export type { AttestationClaims, VerifyOptions };

/** JSON-RPC error code for "attestation required" (implementation-defined range). */
export const MCP_ATTESTATION_ERROR_CODE = -32001;

export type JsonRpcId = string | number | null;

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: { code: number; message: string; data: { reason: string } };
}

export interface GuardOptions extends Omit<VerifyOptions, 'now'> {
  /** Also accept `Authorization: Bearer`. Default false (X-AER-Attestation only). */
  allowBearer?: boolean;
  /** Clock injection for tests (ms). */
  now?: () => number;
  /**
   * Resolve the presented client-cert thumbprint per request (when `requireMtls`).
   * Receives the header getter - use it to read a forwarded client-cert header
   * (`thumbprintFromForwardedClientCert`) behind a TRUSTED proxy. For DIRECT mTLS,
   * resolve from the socket in your handler and pass `mtlsThumbprint` instead.
   * ⚠️ Only read a forwarded cert header behind a proxy you control.
   */
  resolveMtlsThumbprint?: (getHeader: (name: string) => string | null | undefined) => string | null | Promise<string | null>;
}

export type GuardResult =
  | { ok: true; claims: AttestationClaims }
  | { ok: false; status: number; jsonRpcError: JsonRpcError };

type HeaderGetter = (name: string) => string | null | undefined;

/**
 * HTTP status for a denial reason:
 *  - 403  token is authentic but lacks authority: revoked / introspection says
 *         inactive / insufficient_scope (RFC 6750 maps insufficient_scope → 403)
 *  - 503  introspection unreachable + fail-closed (liveness unknown - not the
 *         client's fault, and the token may well be valid)
 *  - 401  everything else: missing / malformed / bad signature / expired /
 *         wrong audience / wrong issuer / DPoP proof failures (RFC 9449 uses 401
 *         with a DPoP challenge - dpop_required / dpop_invalid / dpop_replay)
 */
export function statusForReason(reason: string): number {
  if (reason === 'revoked' || reason === 'insufficient_scope') return 403;
  if (reason === 'introspection_unavailable') return 503;
  return 401;
}

function denial(status: number, reason: string, id: JsonRpcId): GuardResult {
  return {
    ok: false,
    status,
    jsonRpcError: {
      jsonrpc: '2.0',
      id,
      error: { code: MCP_ATTESTATION_ERROR_CODE, message: 'attestation required', data: { reason } },
    },
  };
}

/**
 * Framework-neutral guard. Reads the attestation header, verifies it (offline +
 * optional introspection), and returns either the claims or a ready-to-send
 * JSON-RPC denial + HTTP status. Never reads the request body - pass `rpcId`
 * only if the body was already parsed by your framework (else leave it null so
 * streaming/SSE bodies are untouched).
 */
export async function guardMcpRequest(
  getHeader: HeaderGetter,
  opts: GuardOptions,
  rpcId: JsonRpcId = null,
): Promise<GuardResult> {
  const token = readAttestationHeader(getHeader, opts.allowBearer);
  if (!token) return denial(401, 'missing_attestation', rpcId);
  // When the resource requires DPoP, read the proof from the standard `DPoP`
  // request header (unless the caller already supplied one). method/url come from
  // opts (the framework adapters populate them per request).
  let verifyOpts: VerifyOptions = opts;
  if (opts.requireDpop && opts.dpopProof === undefined) {
    verifyOpts = { ...verifyOpts, dpopProof: getHeader('dpop') ?? null };
  }
  // When the resource requires mTLS and the thumbprint wasn't supplied directly,
  // resolve it per request (forwarded-cert header behind a trusted proxy).
  if (opts.requireMtls && opts.mtlsThumbprint === undefined && opts.resolveMtlsThumbprint) {
    verifyOpts = { ...verifyOpts, mtlsThumbprint: await opts.resolveMtlsThumbprint(getHeader) };
  }
  try {
    const claims = await verifyAttestation(token, verifyOpts);
    return { ok: true, claims };
  } catch (err) {
    const reason = err instanceof AttestationError ? err.code : 'invalid';
    return denial(statusForReason(reason), reason, rpcId);
  }
}
