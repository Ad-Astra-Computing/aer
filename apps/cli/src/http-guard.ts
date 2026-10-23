/** CVE-2026-111497 (Node Brotli decoder OOB write, RCE-capable): fetch()
 * decodes a body lazily on first read, based on the server's own
 * Content-Encoding, and a hostile or misconfigured endpoint picks that
 * header regardless of what was requested. Every fetch in this CLI reads
 * from an operator-configured base_url this process does not control the
 * bytes of, so none of their bodies (including an error path's) are read
 * until this passes. One shared helper rather than a copy per file, so a
 * new call site cannot silently add a fourth or fifth unguarded one. */
export async function assertUncompressed(res: Response): Promise<void> {
  const enc = res.headers.get('content-encoding');
  if (enc !== null && enc.toLowerCase() !== 'identity') {
    await res.body?.cancel().catch(() => {});
    throw new Error(`refusing a response compressed as '${enc}' (CVE-2026-111497)`);
  }
}

/** A compressed response is a deliberate refusal, not a network condition: a
 * retry or poll loop must recognize it and give up immediately, or a hostile
 * endpoint turns every call into a wasted retry/poll budget for no better
 * odds of succeeding. */
export class CompressedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompressedResponseError';
  }
}

/** Same check as assertUncompressed, but raises a CompressedResponseError so
 * a retry/poll loop's catch block can single it out and fail fast instead of
 * retrying it like a dropped connection. */
export async function assertUncompressedOrRetryable(res: Response): Promise<void> {
  const enc = res.headers.get('content-encoding');
  if (enc !== null && enc.toLowerCase() !== 'identity') {
    await res.body?.cancel().catch(() => {});
    throw new CompressedResponseError(`refusing a response compressed as '${enc}' (CVE-2026-111497)`);
  }
}
