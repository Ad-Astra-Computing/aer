// Re-sanitizes a stored event payload before `list_session_events` returns it:
// ingest's own stripping is ingest-only, so a legacy row reads back as stored.
// Re-applies the vendored INGEST_PAYLOAD_KEYS allowlist plus value-shape bounds
// on the READ path. Not vendored/CI-checked against the private API's own
// sanitizer (no shared CI between the two repos); see the commit message.

import { INGEST_PAYLOAD_KEYS } from '../shared/ingest-allowlist.js';

export const MAX_VALUE_STRING_LEN = 2048;
export const MAX_VALUE_ARRAY_ITEMS = 256;
export const MAX_VALUE_OBJECT_KEYS = 64;
export const MAX_VALUE_DEPTH = 4;

/**
 * Token counts under the names the model vendors actually use. A read-back
 * payload may therefore carry different key names than what was sent; the
 * tool description says so (design section 2.2).
 */
export const TOKEN_COUNT_ALIASES: ReadonlyMap<string, string> = new Map([
  ['prompt_tokens', 'input_tokens'],
  ['promptTokens', 'input_tokens'],
  ['inputTokens', 'input_tokens'],
  ['completion_tokens', 'output_tokens'],
  ['completionTokens', 'output_tokens'],
  ['outputTokens', 'output_tokens'],
  ['total_tokens', 'tokens'],
  ['totalTokens', 'tokens'],
]);

function isTokenCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function valueInBounds(v: unknown, depth: number): boolean {
  if (v === null || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return v.length <= MAX_VALUE_STRING_LEN;
  if (depth >= MAX_VALUE_DEPTH) return false;
  if (Array.isArray(v)) {
    if (v.length > MAX_VALUE_ARRAY_ITEMS) return false;
    return v.every((item) => valueInBounds(item, depth + 1));
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length > MAX_VALUE_OBJECT_KEYS) return false;
    return entries.every(([k, item]) => k.length <= 128 && valueInBounds(item, depth + 1));
  }
  return false;
}

const MAX_URL_INPUT_LEN = 65_536;

/** Reduce a URL to `scheme://host[:port]`, same rule as ingest's reduction. */
function reduceUrlToOrigin(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_URL_INPUT_LEN) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) return null;
  const host = u.host.toLowerCase();
  if (host.length === 0 || /[\s/?#@\\]/.test(host)) return null;
  const origin = `${scheme}://${host}`;
  return origin.length <= MAX_VALUE_STRING_LEN ? origin : null;
}

/** Drop a path's query string and fragment, matching `path_redacted`'s promise. */
function redactPathQuery(path: string): string {
  const hash = path.indexOf('#');
  const noFrag = hash >= 0 ? path.slice(0, hash) : path;
  const q = noFrag.indexOf('?');
  if (q < 0) return noFrag;
  return `${noFrag.slice(0, q)}?<redacted>`;
}

export type SanitizedEventPayload =
  | { payload_withheld: false; payload: Record<string, unknown> }
  | { payload_withheld: true; payload: null };

/**
 * Re-sanitize a single event's `payload`. Unknown keys are dropped silently
 * (never named back to the caller, matching ingest's own posture). An
 * allowlisted key whose value is out of bounds withholds the WHOLE payload
 * (`payload_withheld: true`) rather than a partial, possibly-misleading
 * record; the caller keeps the event's own envelope fields (event_id,
 * event_type, timestamp_observed, tool_use_id) regardless.
 */
export function sanitizeEventPayloadForMcp(payload: unknown): SanitizedEventPayload {
  if (payload === null || payload === undefined || typeof payload !== 'object' || Array.isArray(payload)) {
    return { payload_withheld: false, payload: {} };
  }
  const input = payload as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [rawKey, v] of Object.entries(input)) {
    let k = rawKey;
    const canonical = TOKEN_COUNT_ALIASES.get(rawKey);
    if (canonical !== undefined && isTokenCount(v) && input[canonical] === undefined) {
      k = canonical;
    }
    if (!INGEST_PAYLOAD_KEYS.has(k)) continue; // unknown key: dropped, not counted back

    if (k === 'url') {
      const origin = reduceUrlToOrigin(v);
      if (origin === null) continue; // could not reduce: drop rather than store raw
      out[k] = origin;
      continue;
    }
    if (k === 'path_redacted' && typeof v === 'string') {
      const redacted = redactPathQuery(v);
      if (redacted.length > MAX_VALUE_STRING_LEN) {
        return { payload_withheld: true, payload: null };
      }
      out[k] = redacted;
      continue;
    }
    if (!valueInBounds(v, 0)) {
      return { payload_withheld: true, payload: null };
    }
    out[k] = v;
  }
  return { payload_withheld: false, payload: out };
}

/** Envelope fields kept even when the payload is withheld. */
export interface EventEnvelope {
  event_id: string;
  event_type: string;
  timestamp_observed: string;
  tool_use_id?: string | null;
}
