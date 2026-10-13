import type { MiddlewareHandler } from 'hono';
import { verifyAttestation, readAttestationHeader, AttestationError } from './index.js';
import type { VerifyOptions } from './index.js';

// requireMtls/mtlsThumbprint are omitted: there is no per-request client cert
// to read here, so call verifyAttestation directly for mTLS binding.
// method/url/dpopProof are omitted too - this middleware always derives
// them from the real request.
export interface MiddlewareOptions extends Omit<VerifyOptions, 'now' | 'requireMtls' | 'mtlsThumbprint' | 'method' | 'url' | 'dpopProof'> {
  /** Continue (log only, if a logger is configured - see `onFailOpen`) instead of 403 on verification failure. Default false. */
  failOpen?: boolean;
  /** Also accept `Authorization: Bearer`. Default false (X-AER-Attestation only). */
  allowBearer?: boolean;
  /** Called with the denial reason when failOpen admits a request that would otherwise have been denied. */
  onFailOpen?: (reason: string) => void;
}

/** Adapter-level options (transport concerns, not verify). */
export interface HonoAdapterOptions {
  /**
   * Trusted external origin (e.g. `https://payments.example.com`) used to build
   * the DPoP `htu` the proof must match. REQUIRED when `opts.requireDpop` is set:
   * Hono's `c.req.url` is built from the request `Host` header on Node/Bun/Deno,
   * which is client-influenced, so an attacker holding a captured proof could
   * replay it across deployments by spoofing `Host` to match the proof's real
   * origin. Set this to your real public origin.
   */
  trustedOrigin?: string;
}

/**
 * Hono middleware: require a valid AER Attestation token. Fail-closed by default
 * (403). On success, claims are stored at `c.get('aerAttestation')`.
 *
 * Supplies the real per-request method and URL to `verifyAttestation` so
 * `opts.requireDpop` works through this middleware (htm/htu are checked
 * against the actual incoming request, not a value fixed at setup time).
 *
 * Throws synchronously at setup if `opts.requireDpop` is set without
 * `adapterOpts.trustedOrigin` pinned - see `HonoAdapterOptions.trustedOrigin`.
 */
export function honoAerAttestation(opts: MiddlewareOptions, adapterOpts: HonoAdapterOptions = {}): MiddlewareHandler {
  // Runtime guard, not just a type-level Omit, for a plain-JS caller: no
  // per-request client cert is available here to check against.
  if ((opts as { requireMtls?: unknown }).requireMtls) {
    throw new Error('honoAerAttestation: requireMtls is not supported here. Call verifyAttestation directly with a per-request mtlsThumbprint.');
  }
  const trustedOrigin = adapterOpts.trustedOrigin ? assertOrigin(adapterOpts.trustedOrigin, 'honoAerAttestation') : undefined;
  if (opts.requireDpop && !trustedOrigin) {
    throw new Error(
      'honoAerAttestation: requireDpop needs adapterOpts.trustedOrigin pinned to your real public origin. ' +
        'c.req.url is built from the Host header, which lets a client replay a captured proof across deployments by spoofing Host.',
    );
  }
  return async (c, next) => {
    try {
      const token = readAttestationHeader((n) => c.req.header(n), opts.allowBearer);
      if (!token) throw new AttestationError('missing_token');
      // Supply per-request method + URL so DPoP htm/htu can be checked (ignored
      // unless opts.requireDpop). When pinned, trustedOrigin replaces the
      // (client-influenced) origin in c.req.url with the path only; the DPoP
      // htu check itself ignores any query, so dropping it here changes nothing.
      const url = trustedOrigin ? `${trustedOrigin}${new URL(c.req.url).pathname}` : c.req.url;
      const claims = await verifyAttestation(token, { ...opts, method: c.req.method, url, dpopProof: c.req.header('dpop') ?? null });
      c.set('aerAttestation' as never, claims as never);
    } catch (err) {
      if (!opts.failOpen) {
        const reason = err instanceof AttestationError ? err.code : 'invalid';
        return c.json({ error: 'attestation_required', reason }, 403);
      }
      opts.onFailOpen?.(err instanceof AttestationError ? err.code : 'invalid');
    }
    await next();
    return;
  };
}

/** Validate an adapter-pinned trusted origin is exactly `scheme://host[:port]`, no path/query/trailing slash. */
function assertOrigin(value: string, fnName: string): string {
  let origin: string;
  try {
    origin = new URL(value).origin;
  } catch {
    throw new Error(`${fnName}: trustedOrigin "${value}" is not a valid absolute URL (expected e.g. https://payments.example.com).`);
  }
  if (origin !== value.replace(/\/+$/, '')) {
    throw new Error(`${fnName}: trustedOrigin must be exactly "scheme://host[:port]" with no path, query or trailing slash; got "${value}".`);
  }
  return origin;
}
