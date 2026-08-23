// Response-size metadata (impact magnitude, never content). The ONLY source is
// the Content-Length response header - never a body read/buffer, which would
// touch content and add latency. Shared by the fetch and node:http/https
// patches so http.completed carries the same response_bytes semantics either
// way the agent made the call.

/** Parse a raw Content-Length header value into a non-negative integer.
 * Returns undefined for anything absent, malformed, or not a clean
 * non-negative integer (e.g. a list from a misbehaving upstream). */
export function parseContentLength(raw: string | null | undefined): number | undefined {
  // Reject anything that is not a plain string at runtime. node:http can hand a
  // string[] for a repeated header; string-coercing an array (e.g. ['123'] to
  // '123') must never be mistaken for a real length, so gate on the type first.
  if (typeof raw !== 'string') return undefined;
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) return undefined;
  return n;
}

/** Spreadable payload fragment: {} when no valid Content-Length is present,
 * else { response_bytes: n }. Keeps call sites a one-liner and never emits an
 * undefined key. */
export function responseBytesField(raw: string | null | undefined): { response_bytes?: number } {
  const n = parseContentLength(raw);
  return n === undefined ? {} : { response_bytes: n };
}
