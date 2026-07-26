import type { RequestHandler } from 'express';
import { verifyAttestation, readAttestationHeader, AttestationError } from './index.js';
import type { VerifyOptions } from './index.js';

export interface MiddlewareOptions extends Omit<VerifyOptions, 'now'> {
  failOpen?: boolean;
  allowBearer?: boolean;
}

/**
 * Express middleware: require a valid AER Attestation token. Fail-closed by
 * default (403). On success, claims are attached at `req.aerAttestation`.
 */
export function expressAerAttestation(opts: MiddlewareOptions): RequestHandler {
  return (req, res, next) => {
    const token = readAttestationHeader((n) => req.header(n) ?? null, opts.allowBearer);
    void (async () => {
      try {
        if (!token) throw new AttestationError('missing_token');
        const claims = await verifyAttestation(token, opts);
        (req as unknown as { aerAttestation: unknown }).aerAttestation = claims;
        next();
      } catch (err) {
        if (opts.failOpen) { next(); return; }
        const reason = err instanceof AttestationError ? err.code : 'invalid';
        res.status(403).json({ error: 'attestation_required', reason });
      }
    })();
  };
}
