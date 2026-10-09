import type { MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { guardMcpRequest, type GuardOptions } from './index.js';

export interface HonoGuardOptions {
  /**
   * Trusted external origin (e.g. `https://mcp.example.com`) used to build the
   * DPoP `htu` the proof must match. REQUIRED when `requireDpop` is set: Hono's
   * `c.req.url` is built from the request `Host` header on Node/Bun/Deno, which
   * is client-influenced, so an attacker holding a captured proof could replay
   * it across deployments by spoofing `Host` to match the proof's real origin.
   * Set this to your real public origin.
   */
  trustedOrigin?: string;
}

/**
 * Hono middleware guarding an HTTP MCP endpoint. Fail-closed: a request without a
 * valid attestation for `opts.audience` gets a JSON-RPC 2.0 error + 401/403/503.
 * On success, claims are stored at `c.get('aerAttestation')`. The request body is
 * never read (SSE/streaming pass through untouched), so the JSON-RPC id is null.
 *
 * Throws synchronously at setup if `opts.requireDpop` is set without
 * `adapterOpts.trustedOrigin` pinned - see `HonoGuardOptions.trustedOrigin`.
 */
export function honoMcpGuard(opts: GuardOptions, adapterOpts: HonoGuardOptions = {}): MiddlewareHandler {
  const trustedOrigin = adapterOpts.trustedOrigin?.replace(/\/+$/, '');
  if (opts.requireDpop && !trustedOrigin) {
    throw new Error(
      'honoMcpGuard: requireDpop needs adapterOpts.trustedOrigin pinned to your real public origin. ' +
        'c.req.url is built from the Host header, which lets a client replay a captured proof across deployments by spoofing Host.',
    );
  }
  return async (c, next) => {
    // Supply per-request method + URL so DPoP htm/htu can be checked (ignored
    // unless opts.requireDpop). When pinned, trustedOrigin replaces the
    // (client-influenced) origin in c.req.url with the path only; the DPoP
    // htu check itself ignores any query, so dropping it here changes nothing.
    const url = trustedOrigin ? `${trustedOrigin}${new URL(c.req.url).pathname}` : c.req.url;
    const result = await guardMcpRequest((n) => c.req.header(n), { ...opts, method: c.req.method, url });
    if (!result.ok) return c.json(result.jsonRpcError, result.status as ContentfulStatusCode);
    c.set('aerAttestation' as never, result.claims as never);
    await next();
    return;
  };
}
