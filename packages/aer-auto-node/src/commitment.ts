// Content commitments at the customer trust boundary (slice 1).
//
// Cloud/frontier providers are moving to encrypt model reasoning and some
// harness messages under a PROVIDER-held key, so that state becomes opaque to
// the customer AND to third-party auditors. AER cannot (and never claims to)
// recover hidden reasoning. What it CAN do is commit to the facts visible at the
// boundary the customer controls — the request the collector is about to submit
// and the assembled response text — and sign those commitments into the bundle.
//
// The commitment is an HMAC-SHA256 tag under a per-tenant COMMITMENT KEY the
// CUSTOMER holds (AER_COMMITMENT_KEY). This module runs COLLECTOR-SIDE, in the
// customer's own process. Only the tag leaves the process; the plaintext never
// does (bodies-OFF, ADR-008, still holds). Because the key is customer-held, AER
// can neither open a commitment (no preimage) nor brute-force it (no key) — which
// is exactly why bare SHA-256 is unsafe here: prompts and tool args are often
// low-entropy, so an unkeyed hash would be a confirmation oracle. Keyed removes
// that oracle.
//
// This is `aer-canon.v1`. The canonical form is deliberately versioned: it is the
// one thing that cannot be changed later without breaking verification. Verifiers
// recompute the tag over their retained preimage under the same key and compare.
//
// Self-contained (zero deps, node:crypto only) so the published client package
// stays dependency-free.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const CANON_VERSION = 'aer-canon.v1';

/** Minimum accepted commitment-key length. 32 bytes = 256-bit HMAC key. */
const MIN_KEY_BYTES = 32;

/**
 * Parse a commitment key from its string form (env AER_COMMITMENT_KEY). Accepts
 * 64-hex or base64/base64url; requires >= 32 decoded bytes. Returns null on
 * anything shorter or unparseable — the caller treats null as "feature off" and
 * emits NO commitments. There is deliberately no bare-SHA-256 fallback: without a
 * customer key the tags would be a brute-force oracle, so we emit nothing.
 */
export function commitmentKeyFromString(s: string | undefined | null): Buffer | null {
  if (typeof s !== 'string' || s.length === 0) return null;
  // Decode strictly. Node's hex and base64 decoders silently drop invalid
  // characters, so a typo could yield a short or unintended key. Accept only a
  // strict hex, base64 or base64url string and reject anything else (which the
  // caller treats as "feature off").
  let buf: Buffer | null = null;
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) {
    buf = Buffer.from(s, 'hex');
  } else if (/^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length % 4 === 0) {
    buf = Buffer.from(s, 'base64');
  } else if (/^[A-Za-z0-9_-]+$/.test(s)) {
    buf = Buffer.from(s, 'base64url');
  }
  if (!buf || buf.length < MIN_KEY_BYTES) return null;
  return buf;
}

/**
 * kid — a non-secret identifier of which commitment key produced a tag, so a
 * verifier knows which key to use and rotation is possible. Domain-separated
 * ("aer-kid.v1") so kid can never collude with any other place the key might be
 * hashed. 16 hex chars (64 bits) is ample for identification and reveals nothing
 * usable about the key.
 */
export function deriveKid(key: Buffer): string {
  return createHash('sha256').update('aer-kid.v1').update(key).digest('hex').slice(0, 16);
}

/** A message reduced to what enters the hash domain: role + ordered text parts.
 * Provider ids, tool_call_ids and other threading metadata are deliberately
 * excluded. Parts stay an ARRAY so block boundaries are preserved — ["a","b"]
 * must not collapse to "ab". */
interface CanonMessage {
  role: string;
  parts: string[];
}

interface CanonTool {
  name: string;
  schema: unknown;
}

export interface CanonRequest {
  version: typeof CANON_VERSION;
  /** Hoisted system prompt as an ORDERED array of text blocks (Anthropic
   * top-level / OpenAI system|developer msgs). Empty array = no system. Kept an
   * array so ["a","b"] never collapses to "ab". */
  system: string[];
  /** User/assistant messages in submitted order (system hoisted out). */
  messages: CanonMessage[];
  /** Tool definitions in submitted order, normalized to { name, schema }. */
  tools: CanonTool[];
  /** Semantic request params in scope: tool_choice, response_format. Sampling params are excluded. */
  params: Record<string, unknown>;
  /** Count of non-system messages. Bound in the fold preimage. */
  message_count: number;
  /** UTF-8 byte length of the committed prompt text (system + message parts). Bound in the fold preimage. */
  text_bytes: number;
}

// ---- canonical stringify (aer-canon.v1) --------------------------------------
// Mirrors the repo's json-c14n-v1 (sorted object keys, arrays preserve order,
// ES Number-to-String via JSON.stringify) and additionally normalizes every
// string to Unicode NFC. Used only inside HMAC preimages here, never for output.

function canonString(v: string): string {
  return JSON.stringify(v.normalize('NFC'));
}

// Bound on canonicalization recursion. Model/tool-controlled JSON (tool args and
// results) can be adversarially deep; beyond this a value canonicalizes to a
// stable sentinel instead of recursing, so a deeply-nested input can never blow
// the stack. Legit requests nest far shallower than this.
const MAX_CANON_DEPTH = 64;

function canonValue(value: unknown, depth = 0): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return canonString(value as string);
  if (t === 'number') {
    if (!Number.isFinite(value as number)) return 'null'; // non-finite → null (never throws mid-request)
    return JSON.stringify(value);
  }
  if (t === 'boolean') return (value as boolean) ? 'true' : 'false';
  if (t === 'bigint') return JSON.stringify((value as bigint).toString());
  if (t === 'undefined' || t === 'function' || t === 'symbol') return 'null';
  // Depth ceiling: a value nested past the bound is committed as a fixed sentinel
  // rather than recursed. Deterministic, so verification still matches. The
  // sentinel is an UNQUOTED token: every string value is emitted quoted (see
  // canonString), so a bare token can never be produced by any real value,
  // including the literal string "__aer_max_depth__". A quoted sentinel WOULD
  // collide with that literal, letting a >64-deep object and that string share a
  // tag; the bare token removes the ambiguity outright.
  if (depth >= MAX_CANON_DEPTH) return '__aer_max_depth__';
  if (Array.isArray(value)) return '[' + value.map((v) => canonValue(v, depth + 1)).join(',') + ']';
  const obj = value as Record<string, unknown>;
  // Encode every ORIGINAL key distinctly. Keys are NOT NFC-folded: two distinct
  // keys that normalize to the same form (for example a precomposed "é" and a
  // decomposed "é") are different properties, and folding them would drop one
  // from the preimage, a forgeable collision that would let two different request
  // bodies share a tag. Keys keep their raw code points (JSON.stringify escapes
  // them losslessly); only string VALUES are NFC-normalized, by canonString. Object
  // keys are already unique, so sorting the originals is deterministic and lossless.
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) parts.push(JSON.stringify(k) + ':' + canonValue(obj[k], depth + 1));
  return '{' + parts.join(',') + '}';
}

function hmacHex(key: Buffer, preimage: string): string {
  return createHmac('sha256', key).update(preimage, 'utf8').digest('hex');
}

/**
 * prompt_canon_tag — a per-message HMAC fold, so multi-turn cost is O(n) (each
 * new message hashed once) and each message stays independently provable. The
 * fold is HMAC over the JCS of a STRUCTURED object (never string concatenation,
 * which would invite boundary collisions).
 */
export function promptCanonTag(key: Buffer, canon: CanonRequest): string {
  const messageTags = canon.messages.map((m) =>
    hmacHex(key, canonValue({ v: CANON_VERSION, role: m.role, parts: m.parts })),
  );
  const preimage = canonValue({
    v: CANON_VERSION,
    system: canon.system,
    messages: messageTags,
    tools: canon.tools.map((tl) => ({ name: tl.name, schema: tl.schema })),
    params: canon.params,
    // Bound so the signed message_count / prompt_bytes cannot disagree with the
    // committed content — a verifier recomputing the tag must supply matching values.
    message_count: canon.message_count,
    text_bytes: canon.text_bytes,
  });
  return hmacHex(key, preimage);
}

/** response_tag — HMAC over the assembled final text (NFC). Empty output has a
 * defined tag (HMAC of ""), so a partial/aborted completion is unambiguous. Used
 * for BOTH non-streaming and streaming responses (slice 2 accumulates the
 * streamed text in-process on the commitment path); the same text yields the same
 * tag regardless of transport. */
export function responseTag(key: Buffer, text: string): string {
  return hmacHex(key, canonValue({ v: CANON_VERSION, kind: 'response', text }));
}

// ---- slice 2 commitments -----------------------------------------------------
// All domain-separated (their own version string) so a tag from one surface can
// never collide with another, and additive: each is a new field on an existing
// event, gated on a configured commitment key, so no-key bundles are unchanged.

/** A JSON string is parsed to its value so a provider that passes tool args as a
 * JSON STRING (OpenAI `function.arguments`) and one that passes an OBJECT
 * (Anthropic `tool_use.input`) commit to the same tag for the same logical args.
 * Non-strings and unparseable strings pass through unchanged. */
/** Above this the string is NOT JSON-parsed (hashed as a plain string instead),
 * bounding JSON.parse CPU/stack on adversarial model/tool-controlled input. 256
 * KiB is far above any real tool-arg/result payload. */
const MAX_JSONISH_BYTES = 256 * 1024;

function parseJsonish(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  // Oversized strings are committed as-is rather than parsed — the tag stays
  // deterministic (a verifier hashing the same string matches), and a huge/deep
  // JSON string can't force an expensive parse.
  if (Buffer.byteLength(v, 'utf8') > MAX_JSONISH_BYTES) return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/**
 * wire_canon_tag (capture_point: wire) — HMAC over the FULL request body the SDK
 * is about to serialize, not the semantic subset. Where prompt_canon_tag
 * deliberately strips sampling params, provider tool_call_ids and normalizes
 * shapes, the wire tag keeps every field (temperature, top_p, seed, all of it),
 * so a customer who retained the request can prove it. It commits to the
 * CANONICALIZED request object (sorted keys, NFC-normalized string values via
 * canonValue), not the exact serialized wire bytes, so two byte-different but
 * canonically-equal bodies share a tag. Still a one-way HMAC, never the body
 * itself. Domain `aer-wire.v1`.
 */
export function wireBodyTag(key: Buffer, body: unknown): string {
  return hmacHex(key, canonValue({ v: 'aer-wire.v1', body }));
}

/** tool_args_tag — HMAC over one tool call's name + arguments. Cross-provider
 * equivalent: OpenAI's JSON-string arguments and Anthropic's object input produce
 * the same tag for the same logical args. Domain `aer-toolargs.v1`. */
export function toolArgsTag(key: Buffer, name: string, args: unknown): string {
  return hmacHex(key, canonValue({ v: 'aer-toolargs.v1', name, args: parseJsonish(args) }));
}

/** tool_result_tag — HMAC over one tool result's content (the value fed back to
 * the model). JSON-string results and object results of the same data match.
 * Domain `aer-toolresult.v1`. */
export function toolResultTag(key: Buffer, content: unknown): string {
  return hmacHex(key, canonValue({ v: 'aer-toolresult.v1', content: parseJsonish(content) }));
}

/** Constant-time compare of two hex tags (verification helper). */
const TAG_HEX = /^[0-9a-fA-F]{64}$/;

export function tagsEqual(a: string, b: string): boolean {
  // Both operands must be exactly 64 hex chars (a SHA-256 / HMAC-SHA256 tag).
  // Node's hex decoder silently drops invalid nibbles, so validate before
  // decoding rather than compare truncated buffers.
  if (!TAG_HEX.test(a) || !TAG_HEX.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// ---- provider request normalization ------------------------------------------

// Extract the ORDERED text parts of a message/system content. Returns null only
// when the content is not a string or array (unusable). A string is one part; a
// multipart array yields one part per text block (slice-1 is TEXT-ONLY — non-text
// parts like images are not captured and contribute nothing). Boundaries are
// preserved: ["a","b"] never collapses to "ab".
function partsOfContent(content: unknown): string[] | null {
  if (typeof content === 'string') return [content];
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content) {
      if (p && typeof p === 'object') {
        const t = (p as { type?: unknown }).type;
        const txt = (p as { text?: unknown }).text;
        if ((t === 'text' || t === undefined) && typeof txt === 'string') parts.push(txt);
      } else if (typeof p === 'string') {
        parts.push(p);
      }
    }
    return parts;
  }
  return null;
}

function normalizeMessages(rawMessages: unknown): { system: string[]; messages: CanonMessage[] } | null {
  if (!Array.isArray(rawMessages)) return null;
  const system: string[] = [];
  const messages: CanonMessage[] = [];
  for (const m of rawMessages) {
    if (!m || typeof m !== 'object') continue;
    const role = (m as { role?: unknown }).role;
    const parts = partsOfContent((m as { content?: unknown }).content);
    if (typeof role !== 'string' || parts === null) continue;
    if (role === 'system' || role === 'developer') {
      // Hoist system as ordered blocks. Skip empty blocks so an empty system is
      // equivalent to no system.
      for (const p of parts) if (p !== '') system.push(p);
    } else {
      messages.push({ role, parts });
    }
  }
  return { system, messages };
}

function normalizeTools(provider: string, rawTools: unknown): CanonTool[] {
  if (!Array.isArray(rawTools)) return [];
  const out: CanonTool[] = [];
  for (const t of rawTools) {
    if (!t || typeof t !== 'object') continue;
    if (provider === 'anthropic') {
      const name = (t as { name?: unknown }).name;
      const schema = (t as { input_schema?: unknown }).input_schema;
      if (typeof name === 'string') out.push({ name, schema: schema ?? null });
    } else {
      // OpenAI-style { type:'function', function:{ name, parameters } } and the
      // newer flattened { name, parameters }.
      const fn = (t as { function?: unknown }).function;
      const name = (fn as { name?: unknown } | undefined)?.name ?? (t as { name?: unknown }).name;
      const schema = (fn as { parameters?: unknown } | undefined)?.parameters ?? (t as { parameters?: unknown }).parameters;
      if (typeof name === 'string') out.push({ name, schema: schema ?? null });
    }
  }
  return out;
}

function pickParams(req: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  // Semantic request params only. Sampling params (temperature/top_p) are
  // deliberately EXCLUDED and canon.v1 says so.
  if ('tool_choice' in req && req['tool_choice'] !== undefined) params['tool_choice'] = req['tool_choice'];
  if ('response_format' in req && req['response_format'] !== undefined) params['response_format'] = req['response_format'];
  return params;
}

/**
 * Normalize a provider create() call's args into the aer-canon.v1 request shape.
 * Reads message/system/tool BODIES — this runs only when a commitment key is
 * configured, and only the resulting HMAC tag ever leaves the process. Returns
 * null for an unrecognized provider or a request with no usable messages.
 */
export function canonicalizeRequest(provider: string, args: unknown[]): CanonRequest | null {
  const req = args[0] as Record<string, unknown> | undefined;
  if (!req || typeof req !== 'object') return null;
  if (provider !== 'openai' && provider !== 'anthropic') return null;

  const norm = normalizeMessages(req['messages']);
  if (!norm) return null;

  // Anthropic carries system at the top level (string or blocks). Messages carry
  // no system role there, so norm.system is empty — use the top-level blocks.
  let system = norm.system;
  if (provider === 'anthropic' && 'system' in req) {
    const topParts = partsOfContent(req['system']);
    if (topParts !== null) system = topParts.filter((p) => p !== '');
  }

  if (norm.messages.length === 0 && system.length === 0) return null;

  let textBytes = 0;
  for (const s of system) textBytes += Buffer.byteLength(s.normalize('NFC'), 'utf8');
  for (const m of norm.messages) for (const p of m.parts) textBytes += Buffer.byteLength(p.normalize('NFC'), 'utf8');

  return {
    version: CANON_VERSION,
    system,
    messages: norm.messages,
    tools: normalizeTools(provider, req['tools']),
    params: pickParams(req),
    message_count: norm.messages.length,
    text_bytes: textBytes,
  };
}
