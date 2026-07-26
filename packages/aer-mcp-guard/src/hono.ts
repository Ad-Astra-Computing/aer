import type { MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { guardMcpRequest, type GuardOptions } from './index.js';

/**
 * Hono middleware guarding an HTTP MCP endpoint. Fail-closed: a request without a
 * valid attestation for `opts.audience` gets a JSON-RPC 2.0 error + 401/403/503.
 * On success, claims are stored at `c.get('aerAttestation')`. The request body is
 * never read (SSE/streaming pass through untouched), so the JSON-RPC id is null.
 */
export function honoMcpGuard(opts: GuardOptions): MiddlewareHandler {
  return async (c, next) => {
    // Supply per-request method + URL so DPoP htm/htu can be checked (ignored
    // unless opts.requireDpop). c.req.url is the absolute request URL in Hono.
    const result = await guardMcpRequest((n) => c.req.header(n), { ...opts, method: c.req.method, url: c.req.url });
    if (!result.ok) return c.json(result.jsonRpcError, result.status as ContentfulStatusCode);
    c.set('aerAttestation' as never, result.claims as never);
    await next();
    return;
  };
}
