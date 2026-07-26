import type { MiddlewareHandler } from 'hono';
import { verifyAttestation, readAttestationHeader, AttestationError } from './index.js';
import type { VerifyOptions } from './index.js';

export interface MiddlewareOptions extends Omit<VerifyOptions, 'now'> {
  /** Continue (log only) instead of 403 on verification failure. Default false. */
  failOpen?: boolean;
  /** Also accept `Authorization: Bearer`. Default false (X-AER-Attestation only). */
  allowBearer?: boolean;
}

/**
 * Hono middleware: require a valid AER Attestation token. Fail-closed by default
 * (403). On success, claims are stored at `c.get('aerAttestation')`.
 */
export function honoAerAttestation(opts: MiddlewareOptions): MiddlewareHandler {
  return async (c, next) => {
    try {
      const token = readAttestationHeader((n) => c.req.header(n), opts.allowBearer);
      if (!token) throw new AttestationError('missing_token');
      const claims = await verifyAttestation(token, opts);
      c.set('aerAttestation' as never, claims as never);
    } catch (err) {
      if (!opts.failOpen) {
        const reason = err instanceof AttestationError ? err.code : 'invalid';
        return c.json({ error: 'attestation_required', reason }, 403);
      }
    }
    await next();
    return;
  };
}
