import type { RequestHandler } from 'express';
import { guardMcpRequest, type GuardOptions, type JsonRpcId } from './index.js';

/** Adapter-level options for the Express guard (transport concerns, not verify). */
export interface ExpressGuardOptions {
  /**
   * Trusted external origin (e.g. `https://mcp.example.com`) used to build the
   * DPoP `htu` the proof must match. REQUIRED when `requireDpop` is set: the
   * request `Host` header and `req.protocol` are both client-influenced, so
   * deriving the origin from them lets an attacker holding a captured proof
   * replay it across deployments by spoofing `Host` to match the proof's real
   * origin. Set this to your real public origin.
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
 *
 * Throws synchronously at setup if `opts.requireDpop` is set without
 * `adapterOpts.trustedOrigin` pinned - see `ExpressGuardOptions.trustedOrigin`.
 */
export function expressMcpGuard(opts: GuardOptions, adapterOpts: ExpressGuardOptions = {}): RequestHandler {
  const trustedOrigin = adapterOpts.trustedOrigin?.replace(/\/+$/, '');
  if (opts.requireDpop && !trustedOrigin) {
    throw new Error(
      'expressMcpGuard: requireDpop needs adapterOpts.trustedOrigin pinned to your real public origin. ' +
        'Deriving the DPoP htu from the Host header lets a client replay a captured proof across deployments by spoofing Host.',
    );
  }
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
    const rawPath = (req as { originalUrl?: string; url?: string }).originalUrl ?? (req as { url?: string }).url ?? '/';
    // Parsed, not string-joined: a request-target that is itself an absolute
    // URL (Node/Express will still route it) could otherwise smuggle its own
    // scheme/host past a pinned trustedOrigin. new URL(..., 'http://x') drops
    // anything but the real path when the first argument is already absolute.
    const path = new URL(rawPath, 'http://x').pathname;
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
    })().catch(next);
  };
}
