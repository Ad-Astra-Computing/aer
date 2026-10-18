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
  wire?: { tag?: unknown };
  tool_arg_tags?: Array<{ tool?: unknown; tag?: unknown }>;
}

interface ComparableBundleShape {
  content_commitments?: ComparableCommitment[];
  content_commitments_truncated?: unknown;
  execution_graph?: { nodes?: Array<{ type?: unknown }> };
  observations?: { tools_used?: unknown[] };
  llm_activity?: { providers?: Array<{ provider?: unknown; models?: unknown[] }> };
}

export type DivergenceReason = 'kid_mismatch' | 'no_commitments_a' | 'no_commitments_b' | 'truncated';

export interface TagDimension {
  count_a: number;
  count_b: number;
  aligned: boolean;
  // How many positions were actually checked: those where both sides
  // committed under the same key (kid). Can be less than count_a/count_b
  // when a key rotated mid-run, or when the lists are different lengths.
  // `identical:true` is a claim about these positions only.
  compared: number;
  // False when none of the compared positions carried a tag on EITHER side
  // for this dimension (the field is optional, e.g. no session captured a
  // response or a wire body) - there is then no evidence to call equal OR
  // different. `identical` is never true when `applicable` is false.
  applicable: boolean;
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

function emptyTagDimension(countA: number, countB: number): TagDimension {
  return {
    count_a: countA,
    count_b: countB,
    aligned: countA === countB,
    compared: 0,
    applicable: false,
    identical: false,
    first_divergence: null,
  };
}

/**
 * Index-wise comparison of one tag field across two commitment lists,
 * restricted to `positions` - the indices where both sides committed under
 * the SAME key (see `comparableKidPositions`). Position, not any identifier
 * inside the commitment, is the join key: commitment refs are minted per run
 * and carry no cross-run meaning (design doc section 4.2). A position where
 * NEITHER side produced a tag (the field is optional) contributes no
 * evidence either way. A position where only ONE side produced a tag is a
 * real divergence, not an absence - `applicable` must be true for that case
 * too, or a one-sided miss would silently pass as "nothing to compare".
 */
function compareTagField(
  a: ComparableCommitment[],
  b: ComparableCommitment[],
  positions: number[],
  pick: (c: ComparableCommitment) => string | null,
): TagDimension {
  const aligned = a.length === b.length;
  let firstDivergence: number | null = null;
  let applicable = false;
  for (const i of positions) {
    const tagA = pick(a[i]!);
    const tagB = pick(b[i]!);
    if (tagA !== null || tagB !== null) applicable = true;
    if (firstDivergence === null && tagA !== tagB) firstDivergence = i;
  }
  return {
    count_a: a.length,
    count_b: b.length,
    aligned,
    compared: positions.length,
    applicable,
    identical: aligned && applicable && firstDivergence === null,
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
  return isHex64(w.tag) ? w.tag : null;
}

/** tool_arg_tags is a bag per commitment (the generator sorts it by (tool,tag)
 * for determinism, so a plain joined string of the sorted bag is a stable,
 * order-independent fingerprint - never the tool name or tag alone, which
 * would weaken the comparison to "any one call matched"). Returns '' for an
 * explicit empty array (no tool calls - real evidence of "none") and null
 * when the key is absent or malformed (no evidence either way). */
function toolArgsFingerprint(c: ComparableCommitment): string | null {
  const raw = c.tool_arg_tags;
  if (!Array.isArray(raw)) return null;
  const entries: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const tool = entry.tool;
    const tag = entry.tag;
    if (typeof tool !== 'string' || !isHex64(tag)) return null;
    entries.push(`${tool}:${tag}`);
  }
  return entries.sort().join(',');
}

function graphNodeTypes(bundle: ComparableBundleShape): string[] {
  const nodes = bundle.execution_graph?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map((n) => (typeof n === 'object' && n !== null ? n.type : undefined))
    .filter((t): t is string => typeof t === 'string');
}

function toolsUsed(bundle: ComparableBundleShape): string[] {
  const tools = bundle.observations?.tools_used;
  if (!Array.isArray(tools)) return [];
  return tools.filter((t): t is string => typeof t === 'string');
}

function modelSet(bundle: ComparableBundleShape): Set<string> {
  const out = new Set<string>();
  const providers = bundle.llm_activity?.providers;
  if (!Array.isArray(providers)) return out;
  for (const p of providers) {
    if (typeof p !== 'object' || p === null) continue;
    const provider = p.provider;
    const models = p.models;
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

/** Positions (0-indexed, up to the shorter list) where BOTH sides committed
 * under the SAME key. A position where the kids differ or either is
 * malformed/absent is excluded from every tag dimension: it is a key
 * boundary (e.g. mid-run key rotation), not content evidence, and must
 * contribute to neither a divergence nor a match (design doc section 3,
 * "Kid rotation"). Also returns the kid every comparable position shares, or
 * null when more than one distinct kid appears across them. */
function comparableKidPositions(
  a: ComparableCommitment[],
  b: ComparableCommitment[],
): { positions: number[]; kid: string | null } {
  const n = Math.min(a.length, b.length);
  const positions: number[] = [];
  const kidsSeen = new Set<string>();
  for (let i = 0; i < n; i++) {
    const kidA = a[i]!.kid;
    const kidB = b[i]!.kid;
    if (isHex16(kidA) && kidA === kidB) {
      positions.push(i);
      kidsSeen.add(kidA);
    }
  }
  return { positions, kid: kidsSeen.size === 1 ? [...kidsSeen][0]! : null };
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

  const actions = compareActions(bundleA, bundleB);
  const models = { identical: setsEqual(modelSet(bundleA), modelSet(bundleB)) };

  if (commitmentsA.length === 0 || commitmentsB.length === 0) {
    const reason: DivergenceReason = commitmentsA.length === 0 ? 'no_commitments_a' : 'no_commitments_b';
    const empty = emptyTagDimension(commitmentsA.length, commitmentsB.length);
    return {
      comparable: false,
      reason,
      kid: null,
      prompts: empty,
      responses: empty,
      tool_args: empty,
      wire: empty,
      actions,
      models,
    };
  }

  // A commitment list may legitimately mix kids only across a key rotation
  // boundary; comparability requires at least one position where both runs
  // committed under the same key, otherwise no tag in A could ever equal a
  // tag in B (design doc section 3, "Kid rotation").
  const { positions, kid } = comparableKidPositions(commitmentsA, commitmentsB);
  if (positions.length === 0) {
    const empty = emptyTagDimension(commitmentsA.length, commitmentsB.length);
    return {
      comparable: false,
      reason: 'kid_mismatch',
      kid: null,
      prompts: empty,
      responses: empty,
      tool_args: empty,
      wire: empty,
      actions,
      models,
    };
  }

  const prompts = compareTagField(commitmentsA, commitmentsB, positions, singleTag('prompt_canon_tag'));
  const responses = compareTagField(commitmentsA, commitmentsB, positions, singleTag('response_tag'));
  const tool_args = compareTagField(commitmentsA, commitmentsB, positions, toolArgsFingerprint);
  const wire = compareTagField(commitmentsA, commitmentsB, positions, wireTag);

  const anyTruncated = truncated(bundleA) || truncated(bundleB);

  return {
    comparable: true,
    ...(anyTruncated ? { reason: 'truncated' as const } : {}),
    kid,
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
