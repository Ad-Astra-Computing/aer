// compareBundles: did run B get the same inputs and take the same actions as
// run A, and where did it first diverge? Answered from tags, counts and
// booleans already on the bundle (ADR-011 commitments, execution graph,
// observations) - never plaintext, never the network. Callers must verify
// both signatures first; a tag match on unsigned evidence proves nothing.

/** The subset of AerBundle this function reads. Bundles are untrusted JSON, so
 * every field is optional/unknown-shaped at this boundary; absent or malformed
 * data is treated as "no commitments" / "no observations", never thrown. */
interface ComparableCommitment {
  kid?: unknown;
  prompt_canon_tag?: unknown;
  response_tag?: unknown;
  wire?: { tag?: unknown } | unknown;
  tool_arg_tags?: Array<{ tool?: unknown; tag?: unknown }> | unknown;
}

interface ComparableBundleShape {
  content_commitments?: ComparableCommitment[] | unknown;
  content_commitments_truncated?: unknown;
  execution_graph?: { nodes?: Array<{ type?: unknown }> | unknown } | unknown;
  observations?: { tools_used?: unknown[] | unknown } | unknown;
  llm_activity?: { providers?: Array<{ provider?: unknown; models?: unknown[] | unknown }> | unknown } | unknown;
}

export type DivergenceReason = 'kid_mismatch' | 'no_commitments_a' | 'no_commitments_b' | 'truncated';

export interface TagDimension {
  count_a: number;
  count_b: number;
  aligned: boolean;
  identical: boolean;
  first_divergence: number | null;
}

export interface ActionsDimension {
  identical: boolean;
  first_divergence: number | null;
  a_only: string[];
  b_only: string[];
}

export interface CompareBundlesResult {
  /** False when the two bundles carry commitments under different keys (kid
   * mismatch) or either has none: in that case the tag dimensions below are
   * not a meaningful answer and MUST be read as "no_commitments_a" or
   * "no_commitments_b", not "different". `actions` and `models` are still
   * populated when comparable is false, since they never depend on kid. */
  comparable: boolean;
  reason?: DivergenceReason;
  kid: string | null;
  prompts: TagDimension;
  responses: TagDimension;
  tool_args: TagDimension;
  wire: TagDimension;
  actions: ActionsDimension;
  models: { identical: boolean };
}

function isHex64(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

function isHex16(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{16}$/.test(v);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asCommitments(bundle: ComparableBundleShape): ComparableCommitment[] {
  return asArray(bundle.content_commitments).filter(
    (c): c is ComparableCommitment => typeof c === 'object' && c !== null,
  );
}

function truncated(bundle: ComparableBundleShape): boolean {
  return bundle.content_commitments_truncated === true;
}

/** Index-wise comparison of one tag field across two commitment lists. Position,
 * not any identifier inside the commitment, is the join key: commitment refs
 * are minted per run and carry no cross-run meaning (design doc section 4.2). */
function compareTagField(
  a: ComparableCommitment[],
  b: ComparableCommitment[],
  pick: (c: ComparableCommitment) => string | null,
): TagDimension {
  const tagsA = a.map(pick);
  const tagsB = b.map(pick);
  const n = Math.min(tagsA.length, tagsB.length);
  let firstDivergence: number | null = null;
  for (let i = 0; i < n; i++) {
    if (tagsA[i] !== tagsB[i]) {
      firstDivergence = i;
      break;
    }
  }
  const aligned = tagsA.length === tagsB.length;
  const identical = aligned && firstDivergence === null;
  return {
    count_a: tagsA.length,
    count_b: tagsB.length,
    aligned,
    identical,
    first_divergence: firstDivergence,
  };
}

function singleTag(field: 'prompt_canon_tag' | 'response_tag') {
  return (c: ComparableCommitment): string | null => {
    const v = c[field];
    return isHex64(v) ? v : null;
  };
}

function wireTag(c: ComparableCommitment): string | null {
  const w = c.wire;
  if (typeof w !== 'object' || w === null) return null;
  const tag = (w as { tag?: unknown }).tag;
  return isHex64(tag) ? tag : null;
}

/** tool_arg_tags is a bag per commitment (the generator sorts it by (tool,tag)
 * for determinism, so a plain joined string of the sorted bag is a stable,
 * order-independent fingerprint - never the tool name or tag alone, which
 * would weaken the comparison to "any one call matched"). */
function toolArgsFingerprint(c: ComparableCommitment): string | null {
  const raw = c.tool_arg_tags;
  if (!Array.isArray(raw)) return raw === undefined ? null : null;
  const entries: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const tool = (entry as { tool?: unknown }).tool;
    const tag = (entry as { tag?: unknown }).tag;
    if (typeof tool !== 'string' || !isHex64(tag)) return null;
    entries.push(`${tool}:${tag}`);
  }
  if (entries.length === 0) return raw.length === 0 ? '' : null;
  return entries.sort().join(',');
}

function graphNodeTypes(bundle: ComparableBundleShape): string[] {
  const graph = bundle.execution_graph;
  if (typeof graph !== 'object' || graph === null) return [];
  const nodes = (graph as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map((n) => (typeof n === 'object' && n !== null ? (n as { type?: unknown }).type : undefined))
    .filter((t): t is string => typeof t === 'string');
}

function toolsUsed(bundle: ComparableBundleShape): string[] {
  const obs = bundle.observations;
  if (typeof obs !== 'object' || obs === null) return [];
  const tools = (obs as { tools_used?: unknown }).tools_used;
  if (!Array.isArray(tools)) return [];
  return tools.filter((t): t is string => typeof t === 'string');
}

function modelSet(bundle: ComparableBundleShape): Set<string> {
  const activity = bundle.llm_activity;
  const out = new Set<string>();
  if (typeof activity !== 'object' || activity === null) return out;
  const providers = (activity as { providers?: unknown }).providers;
  if (!Array.isArray(providers)) return out;
  for (const p of providers) {
    if (typeof p !== 'object' || p === null) continue;
    const provider = (p as { provider?: unknown }).provider;
    const models = (p as { models?: unknown }).models;
    if (typeof provider !== 'string' || !Array.isArray(models)) continue;
    for (const m of models) {
      if (typeof m === 'string') out.add(`${provider}:${m}`);
    }
  }
  return out;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function compareActions(a: ComparableBundleShape, b: ComparableBundleShape): ActionsDimension {
  const typesA = graphNodeTypes(a);
  const typesB = graphNodeTypes(b);
  const n = Math.min(typesA.length, typesB.length);
  let firstDivergence: number | null = null;
  for (let i = 0; i < n; i++) {
    if (typesA[i] !== typesB[i]) {
      firstDivergence = i;
      break;
    }
  }
  const sameLength = typesA.length === typesB.length;
  const toolsA = new Set(toolsUsed(a));
  const toolsB = new Set(toolsUsed(b));
  const a_only = [...toolsA].filter((t) => !toolsB.has(t)).sort();
  const b_only = [...toolsB].filter((t) => !toolsA.has(t)).sort();
  const identical = sameLength && firstDivergence === null && a_only.length === 0 && b_only.length === 0;
  return { identical, first_divergence: firstDivergence, a_only, b_only };
}

/** Compare two AER bundles' content commitments, execution graph and
 * observation summaries, without reading, requiring or needing any plaintext.
 * Both bundles should already have had their signature verified by the caller
 * (see verifyAerBundle) - a tag match proves nothing against unsigned or
 * tampered evidence. */
export function compareBundles(a: unknown, b: unknown): CompareBundlesResult {
  const bundleA = (typeof a === 'object' && a !== null ? a : {}) as ComparableBundleShape;
  const bundleB = (typeof b === 'object' && b !== null ? b : {}) as ComparableBundleShape;

  const commitmentsA = asCommitments(bundleA);
  const commitmentsB = asCommitments(bundleB);

  const kidsA = new Set(commitmentsA.map((c) => c.kid).filter(isHex16));
  const kidsB = new Set(commitmentsB.map((c) => c.kid).filter(isHex16));

  const actions = compareActions(bundleA, bundleB);
  const models = { identical: setsEqual(modelSet(bundleA), modelSet(bundleB)) };

  const emptyDimension: TagDimension = {
    count_a: 0,
    count_b: 0,
    aligned: true,
    identical: false,
    first_divergence: null,
  };

  if (commitmentsA.length === 0 && commitmentsB.length === 0) {
    return {
      comparable: false,
      reason: 'no_commitments_a',
      kid: null,
      prompts: emptyDimension,
      responses: emptyDimension,
      tool_args: emptyDimension,
      wire: emptyDimension,
      actions,
      models,
    };
  }
  if (commitmentsA.length === 0) {
    return {
      comparable: false,
      reason: 'no_commitments_a',
      kid: null,
      prompts: { ...emptyDimension, count_b: commitmentsB.length, aligned: false },
      responses: { ...emptyDimension, count_b: commitmentsB.length, aligned: false },
      tool_args: { ...emptyDimension, count_b: commitmentsB.length, aligned: false },
      wire: { ...emptyDimension, count_b: commitmentsB.length, aligned: false },
      actions,
      models,
    };
  }
  if (commitmentsB.length === 0) {
    return {
      comparable: false,
      reason: 'no_commitments_b',
      kid: null,
      prompts: { ...emptyDimension, count_a: commitmentsA.length, aligned: false },
      responses: { ...emptyDimension, count_a: commitmentsA.length, aligned: false },
      tool_args: { ...emptyDimension, count_a: commitmentsA.length, aligned: false },
      wire: { ...emptyDimension, count_a: commitmentsA.length, aligned: false },
      actions,
      models,
    };
  }

  // A commitment list may legitimately mix kids only across a key rotation
  // boundary; comparability requires the two RUNS share at least one kid in
  // common, otherwise no tag in A could ever equal a tag in B and the
  // dimensions below would report spurious "different" rather than "not
  // comparable" (design doc section 3, "Kid rotation").
  let sharedKid: string | null = null;
  for (const k of kidsA) {
    if (kidsB.has(k)) {
      sharedKid = k;
      break;
    }
  }
  if (sharedKid === null) {
    return {
      comparable: false,
      reason: 'kid_mismatch',
      kid: null,
      prompts: emptyDimension,
      responses: emptyDimension,
      tool_args: emptyDimension,
      wire: emptyDimension,
      actions,
      models,
    };
  }

  const prompts = compareTagField(commitmentsA, commitmentsB, singleTag('prompt_canon_tag'));
  const responses = compareTagField(commitmentsA, commitmentsB, singleTag('response_tag'));
  const tool_args = compareTagField(commitmentsA, commitmentsB, toolArgsFingerprint);
  const wire = compareTagField(commitmentsA, commitmentsB, wireTag);

  const anyTruncated = truncated(bundleA) || truncated(bundleB);

  return {
    comparable: true,
    ...(anyTruncated ? { reason: 'truncated' as const } : {}),
    kid: sharedKid,
    // When either side truncated its commitment list, `identical` must never
    // claim equality: the untruncated tail could differ without ever being
    // represented in either array (design doc section 8, "False identical
    // from truncation").
    prompts: anyTruncated ? { ...prompts, identical: false } : prompts,
    responses: anyTruncated ? { ...responses, identical: false } : responses,
    tool_args: anyTruncated ? { ...tool_args, identical: false } : tool_args,
    wire: anyTruncated ? { ...wire, identical: false } : wire,
    actions,
    models,
  };
}
