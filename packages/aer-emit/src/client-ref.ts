// client_ref derivation (ADR-023 A1): makes POST /v1/sessions idempotent for a
// repeated open of the same run. Lives in aer-emit so every collector agrees.

import { createHash } from 'node:crypto';

/** What the server's CreateSessionRequest.client_ref field accepts. */
export const CLIENT_REF_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

/**
 * Derive the client_ref for one session open. Never throws: every input is
 * coerced to a string and an empty or unusual value still yields a valid,
 * deterministic 51-character ref (the "v1:" prefix plus 48 hex characters is
 * fixed length regardless of input).
 */
export function deriveClientRef(harness: string, rootHarnessSessionId: string, agentId: string): string {
  const h = String(harness ?? '');
  const r = String(rootHarnessSessionId ?? '');
  const a = String(agentId ?? '');
  const digest = createHash('sha256')
    .update(`aer-client-ref.v1\n${h}\n${r}\n${a}`)
    .digest('hex')
    .slice(0, 48);
  return `v1:${digest}`;
}
