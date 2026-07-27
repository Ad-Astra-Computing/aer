import { z } from 'zod';
import { Uuid } from './id.js';
import { IsoTimestampMs } from './timestamp.js';
import { SESSION_STATUSES } from './event.js';

// Principal attribution (P1): the human, service or CI identity on whose behalf
// a session ran. Optional and never required — `id` is opaque (docs steer
// tenants toward IdP subjects / employee ids, never emails; we don't validate
// PII). `kind` is a closed enum, extensible later. `display` is a short label
// for feeds only. Both `id` and `display` are untrusted, length-capped text
// (React-escaped at every render site — no HTML sinks).
export const Principal = z
  .object({
    id: z.string().min(1).max(128),
    kind: z.enum(['user', 'service', 'ci']),
    display: z.string().min(1).max(64).optional(),
  })
  .strict();
export type Principal = z.infer<typeof Principal>;

// Session tags (P5): customer-supplied grouping labels (deploy id, ticket id,
// experiment). NOT signed into the AER bundle — they describe nothing the agent
// did and are self-asserted by the tenant, so folding them into signed evidence
// would lend cryptographic authority to unauthenticated strings and mislead a
// verifier. They live only as a queryable/display DB attribute.
export const SESSION_TAG_MAX_LEN = 40;
export const SESSION_TAG_MAX_COUNT = 10;
// ASCII allowlist (not a control-char denylist): sidesteps bidi overrides,
// zero-width chars and homoglyph spoofing in the feed UI for free. Requires a
// leading alphanumeric, then letters/digits/`._:/+-`. Widening later is
// backward-compatible; tightening is not, so start strict.
export const SESSION_TAG_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/;

// Normalize the request's tag list server-side. Trims each, drops empties
// silently, dedupes exactly (case-sensitive — `env:Prod` and `env:prod` are
// legitimately distinct), preserves first-seen order (no sort — order is only
// forced by determinism, which is only forced by signing, which we don't do),
// and maps an empty result to null so the "no tags" path is single-valued for
// storage, display, CSV and the json_each filter. Rejects (400) any non-empty
// tag over the length cap or outside the allowlist, and more than the max count
// of DISTINCT tags. Shared trim keeps write-side and read-side (`?tag=`) aligned.
export function normalizeSessionTags(
  input: readonly string[] | undefined,
): { ok: true; tags: string[] | null } | { ok: false; error: 'invalid_tag' | 'too_many_tags' } {
  if (input === undefined) return { ok: true, tags: null };
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const t = raw.trim();
    if (t === '') continue; // drop empties silently
    if (t.length > SESSION_TAG_MAX_LEN || !SESSION_TAG_REGEX.test(t)) {
      return { ok: false, error: 'invalid_tag' };
    }
    if (seen.has(t)) continue; // dedupe, preserve first-seen order
    seen.add(t);
    out.push(t);
  }
  if (out.length === 0) return { ok: true, tags: null }; // []→null
  if (out.length > SESSION_TAG_MAX_COUNT) return { ok: false, error: 'too_many_tags' };
  return { ok: true, tags: out };
}

export const CreateSessionRequest = z
  .object({
    tenant_id: Uuid,
    agent_id: Uuid,
    agent_version: z.string().min(1).max(128),
    environment_id: Uuid,
    metadata: z.record(z.string(), z.unknown()).optional(),
    principal: Principal.optional(),
    // Loose payload bound only (dupes may push raw length past the distinct cap);
    // business rules — charset, length, distinct count, []→null — live in
    // normalizeSessionTags so the 400 reason is precise and shared with the filter.
    tags: z.array(z.string().max(200)).max(64).optional(),
  })
  .strict();

export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export const CreateSessionResponse = z
  .object({
    agent_session_id: Uuid,
    ingest_token: z.string().min(32),
    status: z.literal('running'),
  })
  .strict();

export type CreateSessionResponse = z.infer<typeof CreateSessionResponse>;

export const AgentSession = z
  .object({
    agent_session_id: Uuid,
    tenant_id: Uuid,
    agent_id: Uuid,
    agent_version: z.string().min(1).max(128),
    environment_id: Uuid,
    start_time: IsoTimestampMs,
    end_time: IsoTimestampMs.optional(),
    status: z.enum(SESSION_STATUSES),
    correlation_confidence: z.number().min(0).max(1).optional(),
    baseline_id_applied: Uuid.optional(),
    aer_id: Uuid.optional(),
    // Grouping labels (P5). Present only when the session carried any; the read
    // model exposes them for feeds and filtering. Never signed evidence.
    tags: z.array(z.string()).max(SESSION_TAG_MAX_COUNT).optional(),
  })
  .strict()
  .refine(
    (s) => {
      if (s.end_time === undefined) return true;
      return Date.parse(s.end_time) >= Date.parse(s.start_time);
    },
    { message: 'end_time must be >= start_time', path: ['end_time'] },
  );

export type AgentSession = z.infer<typeof AgentSession>;
