// Usage-policy enforcement (roadmap P3 slice 2), collector side.
//
// The control plane already ships GET /v1/agents/:agent_id/usage-policy, which
// returns a small cost-control policy for an agent. This module is the pure,
// dependency-free enforcement core the collector runs against every LLM call:
// model allow/deny lists, a per-session call budget and a per-session token
// budget. Three modes mirror the protected-resource enforcement pattern:
//   off    - no-op
//   report - emit a policy.violation event, let the call proceed
//   block  - throw AerPolicyError BEFORE the SDK call for the offending call
//
// HONEST CAVEAT: this is best-effort and trivially bypassable by anyone who
// removes the collector. It stops runaway and misconfigured agents, not a
// hostile operator. The strong control is attestation scopes at a protected LLM
// gateway. See the README "Usage policies" section.
//
// Types are inlined (the package is standalone and must not import @aer/*).

export type PolicyMode = 'off' | 'report' | 'block';

export interface UsagePolicyLlm {
  allowed_models?: string[];
  denied_models?: string[];
  max_tokens_per_session?: number;
  max_calls_per_session?: number;
}

/** The shape returned by GET /v1/agents/:agent_id/usage-policy (subset we use). */
export interface UsagePolicy {
  policy_id: string;
  version: number;
  mode: PolicyMode;
  on_unavailable: 'fail_open' | 'fail_closed';
  llm?: UsagePolicyLlm;
}

export type PolicyRule = 'model_denied' | 'model_not_allowed' | 'token_budget' | 'call_budget';

export interface PolicyViolation {
  rule: PolicyRule;
  model?: string;
  limit?: number;
  observed?: number;
  /** report => the call proceeds; block => the caller throws AerPolicyError. */
  action: 'report' | 'block';
}

export interface AerPolicyErrorFields {
  rule: PolicyRule;
  model?: string;
  limit?: number;
  observed?: number;
  policyId: string;
  version: number;
}

/**
 * Thrown by the wrapped LLM `create` in BLOCK mode, before the SDK call happens,
 * when a call violates the policy. This is the ONLY case policy enforcement
 * throws into the host: every other enforcement path is fail-open.
 */
export class AerPolicyError extends Error {
  readonly rule: PolicyRule;
  readonly model?: string;
  readonly limit?: number;
  readonly observed?: number;
  readonly policyId: string;
  readonly version: number;

  constructor(fields: AerPolicyErrorFields) {
    super(policyMessage(fields));
    this.name = 'AerPolicyError';
    this.rule = fields.rule;
    if (fields.model !== undefined) this.model = fields.model;
    if (fields.limit !== undefined) this.limit = fields.limit;
    if (fields.observed !== undefined) this.observed = fields.observed;
    this.policyId = fields.policyId;
    this.version = fields.version;
    // Keep the prototype chain right when compiled down.
    Object.setPrototypeOf(this, AerPolicyError.prototype);
  }
}

function policyMessage(f: AerPolicyErrorFields): string {
  switch (f.rule) {
    case 'model_denied':
      return `AER usage policy blocked model "${f.model ?? '(unknown)'}" (denied)`;
    case 'model_not_allowed':
      return `AER usage policy blocked model "${f.model ?? '(unknown)'}" (not in allowed_models)`;
    case 'call_budget':
      return `AER usage policy blocked call: exceeds max_calls_per_session ${f.limit} (observed ${f.observed})`;
    case 'token_budget':
      return `AER usage policy: exceeds max_tokens_per_session ${f.limit} (observed ${f.observed})`;
  }
}

/**
 * Glob-ish model match. Case-sensitive exact match plus `*` wildcards, where a
 * single `*` matches any run of characters (including empty). No other regex
 * metacharacters are honored: everything else is matched literally. Empty
 * pattern list => no match.
 */
export function matchModel(patterns: string[], model: string): boolean {
  for (const pattern of patterns) {
    if (globToRegExp(pattern).test(model)) return true;
  }
  return false;
}

function globToRegExp(pattern: string): RegExp {
  // Escape every regex metachar, then turn the escaped '*' back into '.*'.
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Pure per-session policy state machine. Built from a UsagePolicy or null
 * (disabled). Tracks cumulative tokens and call count. Never throws.
 */
export class PolicyEnforcer {
  private readonly policy: UsagePolicy | null;
  private tokens = 0;
  private calls = 0;

  constructor(policy: UsagePolicy | null) {
    // Treat 'off' as disabled up front, so every hot-path method is a cheap
    // early-return and never allocates.
    this.policy = policy && policy.mode !== 'off' ? policy : null;
  }

  /** True when a governing policy is present and its mode is report or block. */
  get active(): boolean {
    return this.policy !== null;
  }

  get policyId(): string {
    return this.policy?.policy_id ?? '';
  }

  get version(): number {
    return this.policy?.version ?? 0;
  }

  get mode(): PolicyMode {
    return this.policy?.mode ?? 'off';
  }

  /**
   * Evaluate the pre-call rules (model allow/deny + call budget) and increment
   * the call count. Returns every violation; in block mode the first blocking
   * violation is also returned as `block` (the caller throws AerPolicyError and
   * must NOT invoke the SDK). Never throws.
   */
  beforeCall(model: string | undefined): { violations: PolicyViolation[]; block: PolicyViolation | null } {
    const policy = this.policy;
    if (!policy) return { violations: [], block: null };
    const action: 'report' | 'block' = policy.mode === 'block' ? 'block' : 'report';
    const llm = policy.llm ?? {};
    const violations: PolicyViolation[] = [];

    // Model rules. Denied wins over the allowlist.
    const denied = llm.denied_models;
    const allowed = llm.allowed_models;
    if (denied && denied.length > 0 && model !== undefined && matchModel(denied, model)) {
      violations.push({ rule: 'model_denied', action, ...(model !== undefined ? { model } : {}) });
    } else if (allowed && allowed.length > 0 && !(model !== undefined && matchModel(allowed, model))) {
      violations.push({ rule: 'model_not_allowed', action, ...(model !== undefined ? { model } : {}) });
    }

    // Call budget: increment first, then compare. Exceeding (not reaching) the
    // max is a violation, so max_calls_per_session=2 allows calls 1 and 2.
    this.calls += 1;
    const maxCalls = llm.max_calls_per_session;
    if (maxCalls !== undefined && this.calls > maxCalls) {
      violations.push({ rule: 'call_budget', limit: maxCalls, observed: this.calls, action });
    }

    const block = action === 'block' ? (violations[0] ?? null) : null;
    return { violations, block };
  }

  /**
   * Fold this call's token usage into the cumulative total and emit a
   * token_budget violation when the total EXCEEDS the max. Tokens are known only
   * post-call, so this is report-after: even in block mode it records the
   * violation (with action per mode) and never throws. A subsequent beforeCall
   * cannot un-send the call that already happened.
   */
  afterCall(inputTokens?: number, outputTokens?: number): PolicyViolation[] {
    const policy = this.policy;
    if (!policy) return [];
    const llm = policy.llm ?? {};
    const maxTokens = llm.max_tokens_per_session;
    const add = (safeCount(inputTokens)) + (safeCount(outputTokens));
    this.tokens += add;
    if (maxTokens === undefined || this.tokens <= maxTokens) return [];
    const action: 'report' | 'block' = policy.mode === 'block' ? 'block' : 'report';
    return [{ rule: 'token_budget', limit: maxTokens, observed: this.tokens, action }];
  }
}

function safeCount(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}
