import type { RequestHandler } from 'express';
import { guardMcpRequest, type GuardOptions, type JsonRpcId } from './index.js';

/** Adapter-level options for the Express guard (transport concerns, not verify). */
export interface ExpressGuardOptions {
  /**
   * Trusted external origin (e.g. `https://mcp.example.com`) used to build the
   * DPoP `htu` the proof must match. STRONGLY recommended when `requireDpop` is
   * set: without it the origin is derived from the request `Host` header and
   * `req.protocol`, both client-influenced. An attacker can then set `Host` to
   * match a proof captured for a different endpoint, weakening htu binding.
   * Set this to your real public origin (or configure Express `trust proxy` and
   * a proxy that overwrites Host). Ignored unless `requireDpop` is used.
   */
  trustedOrigin?: string;
}

/**
 * Express middleware guarding an HTTP MCP endpoint. Fail-closed: a request without
 * a valid attestation for `opts.audience` gets a JSON-RPC 2.0 error + 401/403/503.
 * On success, claims are attached at `req.aerAttestation`.
 *
 * The JSON-RPC id is echoed ONLY when a body parser has already buffered the body
 * (`req.body`); the guard never consumes the stream itself, so SSE / streaming
 * Streamable-HTTP requests are left intact.
 */
export function expressMcpGuard(opts: GuardOptions, adapterOpts: ExpressGuardOptions = {}): RequestHandler {
  const trustedOrigin = adapterOpts.trustedOrigin?.replace(/\/+$/, '');
  return (req, res, next) => {
    const body = (req as { body?: unknown }).body;
    const rpcId: JsonRpcId =
      body && typeof body === 'object' && 'id' in body
        ? ((body as { id?: JsonRpcId }).id ?? null)
        : null;
    // Absolute URL for DPoP htu (ignored unless opts.requireDpop). Query is
    // dropped during htu normalization, so the path is what matters. Prefer a
    // pinned trustedOrigin; otherwise fall back to the (client-influenced) Host
    // header + req.protocol - safe only when htu binding isn't relied upon or a
    // trusted proxy fixes the Host.
    const getHeader = (n: string): string | null => req.header(n) ?? null;
    const path = (req as { originalUrl?: string; url?: string }).originalUrl ?? (req as { url?: string }).url ?? '/';
    const origin = trustedOrigin ?? `${req.protocol || 'https'}://${getHeader('host') ?? 'localhost'}`;
    const url = `${origin}${path}`;
    void (async () => {
      const result = await guardMcpRequest(getHeader, { ...opts, method: req.method, url }, rpcId);
      if (result.ok) {
        (req as unknown as { aerAttestation: unknown }).aerAttestation = result.claims;
        next();
        return;
      }
      res.status(result.status).json(result.jsonRpcError);
    })();
  };
}
