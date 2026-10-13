import type { RequestHandler } from 'express';
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
export interface ExpressAdapterOptions {
  /**
   * Trusted external origin (e.g. `https://payments.example.com`) used to build
   * the DPoP `htu` the proof must match. REQUIRED when `opts.requireDpop` is set:
   * the request `Host` header and `req.protocol` are both client-influenced, so
   * deriving the origin from them lets an attacker holding a captured proof
   * replay it across deployments by spoofing `Host` to match the proof's real
   * origin. Set this to your real public origin.
   */
  trustedOrigin?: string;
}

/**
 * Express middleware: require a valid AER Attestation token. Fail-closed by
 * default (403). On success, claims are attached at `req.aerAttestation`.
 *
 * Supplies the real per-request method and URL to `verifyAttestation` so
 * `opts.requireDpop` works through this middleware (htm/htu are checked
 * against the actual incoming request, not a value fixed at setup time).
 *
 * Throws synchronously at setup if `opts.requireDpop` is set without
 * `adapterOpts.trustedOrigin` pinned - see `ExpressAdapterOptions.trustedOrigin`.
 */
export function expressAerAttestation(opts: MiddlewareOptions, adapterOpts: ExpressAdapterOptions = {}): RequestHandler {
  // Runtime guard, not just a type-level Omit, for a plain-JS caller: no
  // per-request client cert is available here to check against.
  if ((opts as { requireMtls?: unknown }).requireMtls) {
    throw new Error('expressAerAttestation: requireMtls is not supported here. Call verifyAttestation directly with a per-request mtlsThumbprint.');
  }
  const trustedOrigin = adapterOpts.trustedOrigin ? assertOrigin(adapterOpts.trustedOrigin, 'expressAerAttestation') : undefined;
  if (opts.requireDpop && !trustedOrigin) {
    throw new Error(
      'expressAerAttestation: requireDpop needs adapterOpts.trustedOrigin pinned to your real public origin. ' +
        'Deriving the DPoP htu from the Host header lets a client replay a captured proof across deployments by spoofing Host.',
    );
  }
  return (req, res, next) => {
    void (async () => {
      try {
        const getHeader = (n: string): string | null => req.header(n) ?? null;
        const token = readAttestationHeader(getHeader, opts.allowBearer);
        if (!token) throw new AttestationError('missing_token');
        // Absolute URL for DPoP htu (ignored unless opts.requireDpop). Query is
        // dropped during htu normalization, so the path is what matters. Prefer
        // a pinned trustedOrigin; otherwise fall back to the (client-influenced)
        // Host header + req.protocol - safe only when htu binding isn't relied
        // upon or a trusted proxy fixes the Host. Computed inside this try: a
        // malformed request-target must deny (403), never escape as a 500.
        const rawPath = (req as unknown as { originalUrl?: string; url?: string }).originalUrl ?? (req as unknown as { url?: string }).url ?? '/';
        const path = requestPath(rawPath);
        const origin = trustedOrigin ?? `${req.protocol || 'https'}://${getHeader('host') ?? 'localhost'}`;
        const url = `${origin}${path}`;
        const claims = await verifyAttestation(token, { ...opts, method: req.method, url, dpopProof: getHeader('dpop') });
        (req as unknown as { aerAttestation: unknown }).aerAttestation = claims;
        next();
      } catch (err) {
        if (opts.failOpen) { opts.onFailOpen?.(err instanceof AttestationError ? err.code : 'invalid'); next(); return; }
        const reason = err instanceof AttestationError ? err.code : 'invalid';
        res.status(403).json({ error: 'attestation_required', reason });
      }
    })();
  };
}

/**
 * The request's path, for the DPoP htu. Origin-form targets (what Express
 * actually routes on for an ordinary request, `/a/b?x=1`) are used verbatim -
 * including a leading `//`, which `new URL(path, 'http://x')` would otherwise
 * reinterpret as an authority and silently drop, diverging from what Express
 * itself sees. Anything else (an absolute-URL request-target) is parsed so
 * only the real path can reach the trustedOrigin-pinned htu, never a
 * smuggled scheme/host.
 */
function requestPath(rawPath: string): string {
  if (rawPath.startsWith('/') && !rawPath.startsWith('//')) {
    const q = rawPath.indexOf('?');
    return q === -1 ? rawPath : rawPath.slice(0, q);
  }
  return new URL(rawPath, 'http://x').pathname;
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
