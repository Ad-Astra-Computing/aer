import { z } from 'zod';
import { Uuid } from './id.js';
import { IsoTimestampMs } from './timestamp.js';
import { SOURCE_TYPES, SEVERITY_HINTS } from './event.js';
import { canonicalHash } from './canonical.js';
import { Principal } from './session.js';
import { PolicyVerdict } from './policy.js';

const Sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'expected 64 lowercase hex chars');

const HexId = z.string().regex(/^[0-9a-f]+$/, 'expected lowercase hex');

export const GraphNode = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    timestamp: IsoTimestampMs,
    payload_digest: Sha256Hex,
    label: z.string().optional(),
  })
  .strict();
export type GraphNode = z.infer<typeof GraphNode>;

export const GraphEdge = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    kind: z.enum(['temporal', 'request-response', 'session-span']),
  })
  .strict();
export type GraphEdge = z.infer<typeof GraphEdge>;

export const ExecutionGraph = z
  .object({
    nodes: z.array(GraphNode),
    edges: z.array(GraphEdge),
  })
  .strict();
export type ExecutionGraph = z.infer<typeof ExecutionGraph>;

export const TimeWindow = z
  .object({
    start: IsoTimestampMs,
    end: IsoTimestampMs,
  })
  .strict()
  .refine((w) => Date.parse(w.end) >= Date.parse(w.start), {
    message: 'end must be >= start',
    path: ['end'],
  });
export type TimeWindow = z.infer<typeof TimeWindow>;

export const Environment = z
  .object({
    name: z.string().min(1),
    host_ids: z.array(z.string()),
    container_ids: z.array(z.string()),
  })
  .strict();
export type Environment = z.infer<typeof Environment>;

export const Correlation = z
  .object({
    session_confidence: z.number().min(0).max(1),
    sources: z.array(z.enum(SOURCE_TYPES)),
  })
  .strict();
export type Correlation = z.infer<typeof Correlation>;

// Generous upper bounds: large enough that no legitimately-generated bundle is
// ever rejected (the generator caps observations at 1000 values / 512 chars, and
// old bundles are smaller still), but finite so a pathological array can't force
// unbounded memory when a stored bundle is parsed. Defense-in-depth on a signed
// artifact — the primary control is the event-ingest size cap.
const MAX_BUNDLE_LIST = 100_000;
// Per-commitment cap on tool-result tags (slice 2). Bounds a single
// attacker-controlled llm.prompt_committed event; excess sets tool_results_truncated.
const MAX_TOOL_RESULT_TAGS = 256;
// Per-commitment cap on tool-argument tags (slice 2). Same posture, independent
// semantics (outgoing tool calls); excess sets tool_args_truncated.
const MAX_TOOL_ARG_TAGS = 256;
const MAX_BUNDLE_STR = 65_536;
const ObservationName = z.string().max(MAX_BUNDLE_STR);

export const Observations = z
  .object({
    domains_contacted: z.array(ObservationName).max(MAX_BUNDLE_LIST),
    tools_used: z.array(ObservationName).max(MAX_BUNDLE_LIST),
    files_touched: z.array(ObservationName).max(MAX_BUNDLE_LIST),
    processes_spawned: z.array(ObservationName).max(MAX_BUNDLE_LIST),
  })
  .strict();
export type Observations = z.infer<typeof Observations>;

// Semantic LLM/tool activity summary, aggregated from llm.*/tool.selected events
// at generation time. METADATA ONLY (providers, models, counts, token totals
// where the SDK surfaced usage, tool names + tallies) — never prompts, model
// text, or tool arguments. Optional so pre-v1.1 bundles remain valid.
export const LlmActivityProvider = z
  .object({
    provider: z.string().min(1),
    calls: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    streaming: z.number().int().nonnegative(),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    // false when no completion surfaced token usage (token sums are then 0 and
    // shown honestly as "not reported" rather than implying zero usage).
    tokens_observed: z.boolean(),
    models: z.array(z.string()),
    tool_selections: z.number().int().nonnegative(),
  })
  .strict();
export type LlmActivityProvider = z.infer<typeof LlmActivityProvider>;

export const LlmActivityTotals = z
  .object({
    calls: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    streaming: z.number().int().nonnegative(),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    tokens_observed: z.boolean(),
    tool_selections: z.number().int().nonnegative(),
  })
  .strict();
export type LlmActivityTotals = z.infer<typeof LlmActivityTotals>;

// P4: estimated LLM spend for the run, derived at generation time from the token
// totals above and a VERSIONED price table shipped with the generator. Money is
// integer MICRO-USD (1e-6 USD) so the signed bundle holds only integers (floats
// would make the canonical hash depend on serialization). This is an ESTIMATE
// against list prices recorded by `price_table_version`, not a bill. `coverage`
// states how much of the spend could be priced: a provider is priced only when it
// used a single recognized model with observed tokens, so a run that pooled
// several models under one provider is honestly reported as 'partial'/'none'.
export const EstimatedCost = z
  .object({
    currency: z.literal('USD'),
    price_table_version: z.string().min(1).max(MAX_BUNDLE_STR),
    // Finite upper bounds mirror the generator's guarantees (usd_micros saturates
    // at 1e15; provider counts are bounded by the summary's provider cap). Defense
    // in depth when a stored/attacker-influenced bundle is parsed.
    usd_micros: z.number().int().nonnegative().max(1_000_000_000_000_000),
    coverage: z.enum(['full', 'partial', 'none']),
    priced_providers: z.number().int().nonnegative().max(MAX_BUNDLE_LIST),
    unpriced_providers: z.number().int().nonnegative().max(MAX_BUNDLE_LIST),
  })
  .strict();
export type EstimatedCost = z.infer<typeof EstimatedCost>;

export const LlmActivity = z
  .object({
    providers: z.array(LlmActivityProvider),
    totals: LlmActivityTotals,
    tools: z.array(
      z.object({ tool: z.string().min(1), count: z.number().int().positive() }).strict(),
    ),
    // True when name lists (providers/models/tools) were capped or a name was
    // clamped. Numeric totals stay authoritative regardless. Present only when
    // truncation happened, so untruncated summaries keep their canonical form.
    truncated: z.literal(true).optional(),
    // Optional so pre-P4 bundles and sessions with no priceable activity keep
    // their canonical form. Emitted for every bundle that has llm_activity.
    estimated_cost: EstimatedCost.optional(),
  })
  .strict();
export type LlmActivity = z.infer<typeof LlmActivity>;

export const ImpactSummary = z
  .object({
    classes: z.array(z.string()),
    highest_severity: z.enum(SEVERITY_HINTS),
  })
  .strict();
export type ImpactSummary = z.infer<typeof ImpactSummary>;

export const TransparencyLog = z
  .object({
    kind: z.literal('sigstore-rekor'),
    uuid: z.string().min(1),
    log_index: z.number().int().nonnegative(),
    integrated_time: z.number().int().nonnegative(),
  })
  .strict();
export type TransparencyLog = z.infer<typeof TransparencyLog>;

export const Integrity = z
  .object({
    canonicalization: z.literal('json-c14n-v1'),
    hash_alg: z.literal('sha256'),
    hash: Sha256Hex,
    sig_alg: z.literal('ed25519'),
    signature: z.string().min(1),
    signing_key_id: HexId,
    anchored: z.boolean(),
    transparency_log: TransparencyLog.optional(),
  })
  .strict();
export type Integrity = z.infer<typeof Integrity>;

export const Exports = z
  .object({
    prov_available: z.boolean(),
    human_report_available: z.boolean(),
  })
  .strict();
export type Exports = z.infer<typeof Exports>;

// Content commitment at the customer trust boundary (slice 1, ADR-011). Each
// entry is an HMAC tag over the request the collector was about to submit (and,
// when captured, the assembled response), computed COLLECTOR-SIDE under a
// customer-held key. AER holds neither the key nor the plaintext, so it can
// neither open nor brute-force a tag; these fields are signed so the commitments
// inherit the bundle's tamper-evidence. `declared` carries client self-reports
// (unverified) — kept OUT of any verified claim. `retained` records preimage
// custody so a `none` bundle is never silently un-openable.
export const ContentCommitment = z
  .object({
    request_ref: z.string().min(1).max(128),
    provider: z.string().min(1).max(200),
    model: z.string().min(1).max(200),
    kid: z.string().regex(/^[0-9a-f]{16}$/, 'expected 16-hex kid'),
    canon: z.literal('aer-canon.v1'),
    // Where the collector computed the tag. Object-level (adapter request) in
    // slice 1; wire-body capture is additive in a later slice.
    capture_point: z.literal('adapter_request'),
    prompt_canon_tag: Sha256Hex,
    // Present only when the response text was captured (non-streaming in slice 1).
    response_tag: Sha256Hex.optional(),
    // Wire-body commitment (slice 2): an HMAC over the FULL request body as sent
    // (sampling params and all), the byte-level peer of the semantic
    // prompt_canon_tag. The canon marker and tag travel together so the pair is
    // atomic. Optional: absent on slice-1 and no-key bundles, so their canonical
    // form is byte-for-byte unchanged.
    wire: z.object({ canon: z.literal('aer-wire.v1'), tag: Sha256Hex }).strict().optional(),
    // Commitments over tool-execution outputs fed back INTO this request (slice 2).
    // Each tag is an HMAC over one prior tool result; order is as the collector
    // observed them. Bounded so an attacker-controlled event cannot bloat the bundle.
    tool_result_tags: z.array(Sha256Hex).max(MAX_TOOL_RESULT_TAGS).optional(),
    // Set when tool_result_tags was capped or had malformed elements dropped, so
    // this commitment's tool-result evidence never silently under-reports.
    tool_results_truncated: z.literal(true).optional(),
    // Commitments over tool CALLS the model emitted in THIS request's response
    // (outgoing, the dual of tool_result_tags). Each pair binds the tool name to an
    // HMAC over that call's arguments. Sorted by (tool, tag) for determinism and
    // bounded per-commitment. tool name is attacker-controlled, so length-capped.
    tool_arg_tags: z.array(z.object({ tool: z.string().min(1).max(200), tag: Sha256Hex }).strict()).max(MAX_TOOL_ARG_TAGS).optional(),
    // Set when tool_arg_tags was capped or had malformed elements dropped.
    tool_args_truncated: z.literal(true).optional(),
    outcome: z.enum(['ok', 'error', 'aborted', 'partial']),
    // Bound in-domain (equals the hashed message list length).
    message_count: z.number().int().min(0),
    // Declared, unverified: size of the committed prompt text in bytes.
    prompt_bytes: z.number().int().min(0),
    // Preimage custody. `none` = customer retains the plaintext out of band.
    retained: z.enum(['none', 'customer_ref']),
    at: IsoTimestampMs,
  })
  .strict();
export type ContentCommitment = z.infer<typeof ContentCommitment>;

// Key-bound identity assurance (ADR-015). Records, per axis, how the session's
// agent and principal were established. The two axes are independent because a
// key may bind either, both or neither. `absent` applies only to `principal`,
// for a session that carried no principal at all.
export const IdentityAssurance = z
  .object({
    agent: z.enum(['credential_bound', 'self_asserted']),
    principal: z.enum(['credential_bound', 'self_asserted', 'absent']),
  })
  .strict();
export type IdentityAssurance = z.infer<typeof IdentityAssurance>;

export const AerBundle = z
  .object({
    schema_version: z.literal('aer.v1'),
    aer_id: Uuid,
    tenant_id: Uuid,
    agent_id: Uuid,
    agent_version: z.string().min(1),
    agent_session_id: Uuid,
    time_window: TimeWindow,
    environment: Environment,
    correlation: Correlation,
    execution_graph: ExecutionGraph,
    observations: Observations,
    // Principal attribution (P1): who the run acted on behalf of. Signed into
    // the bundle so attribution is part of the evidence, not console decoration.
    // Optional so pre-P1 bundles and no-principal sessions stay valid (and the
    // canonical form of a no-principal bundle omits this key entirely).
    principal: Principal.optional(),
    // Key-bound identity assurance (ADR-015): per axis, how the agent and
    // principal were established. `credential_bound` means the caller held an API
    // key an admin pinned to that identity, a materially stronger claim than the
    // `self_asserted` string a caller typed. Signed so a verifier can tell them
    // apart. Optional so pre-ADR-015 bundles stay valid and the canonical form of
    // a no-assurance bundle omits the key entirely.
    identity_assurance: IdentityAssurance.optional(),
    llm_activity: LlmActivity.optional(),
    deviations: z.array(z.unknown()).max(MAX_BUNDLE_LIST),
    impact_summary: ImpactSummary,
    policy_decisions: z.array(z.unknown()).max(MAX_BUNDLE_LIST),
    // P3: the usage-policy the run declared it was governed by, and how many
    // violations the collector reported. Self-reported (collector-side), so it
    // records what ran, not a cryptographic proof of enforcement. Omitted when
    // the session ran under no policy.
    policy_verdict: PolicyVerdict.optional(),
    // Content commitments (ADR-011). Omitted when the session emitted none (no
    // commitment key configured), so the canonical form is unchanged for the
    // common case.
    content_commitments: z.array(ContentCommitment).max(MAX_BUNDLE_LIST).optional(),
    // Signed truncation signal: present only when the commitment list hit the cap
    // and some were dropped, so evidence never silently under-reports.
    content_commitments_truncated: z.literal(true).optional(),
    integrity: Integrity,
    exports: Exports,
  })
  .strict();
export type AerBundle = z.infer<typeof AerBundle>;

export type AerBundleUnsigned = Omit<AerBundle, 'integrity'>;

export function stripIntegrity<T extends Record<string, unknown>>(bundle: T): Omit<T, 'integrity'> {
  const copy: Record<string, unknown> = { ...bundle };
  delete copy['integrity'];
  return copy as Omit<T, 'integrity'>;
}

export function hashBundleForSigning(bundle: Record<string, unknown>): string {
  return canonicalHash(stripIntegrity(bundle));
}
