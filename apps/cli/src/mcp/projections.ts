// One explicit field-allowlist projection per tool. Each function NARROWS a
// REST response: only the keys in its own allowlist survive, so an
// unlisted key (a new wire field or an adversarial one) is dropped by
// construction. Field rules are in the commit message, not here.

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clamp(v: unknown, maxLen: number): unknown {
  return typeof v === 'string' && v.length > maxLen ? v.slice(0, maxLen) : v;
}

/** Copy only `keys` from `src`. Keys absent from `src` are simply absent from the result. */
function pick(src: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k in src) out[k] = src[k];
  }
  return out;
}

const PRINCIPAL_FIELDS = ['id', 'kind'] as const; // display dropped

function projectPrincipal(v: unknown): Record<string, unknown> | undefined {
  if (!isRecord(v)) return undefined;
  return pick(v, PRINCIPAL_FIELDS);
}

const DISPOSITION_FIELDS = ['status', 'reason_code', 'updated_at'] as const; // reason, actor_user_id dropped

function projectDisposition(v: unknown): Record<string, unknown> | undefined {
  if (!isRecord(v)) return undefined;
  return pick(v, DISPOSITION_FIELDS);
}

const AGENT_FIELDS = [
  'agent_id', 'tenant_id', 'name', 'status', 'coverage',
  'created_at', 'updated_at', 'last_seen_at', 'environment_id', 'tags',
  'risk_max_severity', 'permission_modes', 'models_used',
  'agent_version', 'framework_type', 'last_harness', 'last_collector_name', 'collector_version',
] as const; // repo_ref, paused_reason, paused_by, key_bindings dropped

export function projectAgent(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return {};
  const out = pick(raw, AGENT_FIELDS);
  if ('agent_version' in out) out['agent_version'] = clamp(out['agent_version'], 128);
  if ('framework_type' in out) out['framework_type'] = clamp(out['framework_type'], 64);
  return out;
}

const SESSION_FIELDS = [
  'session_id', 'tenant_id', 'agent_id', 'environment_id', 'status',
  'created_at', 'started_at', 'ended_at', 'end_reason', 'end_detail',
  'coverage', 'risk_max_severity', 'permission_modes', 'models_used',
  'subagent_count', 'subagent_ids', 'seq_gap_count',
  'policy_id', 'policy_version', 'policy_mode',
  'llm_activity', 'sources', 'tags', 'session_ref', 'archived',
] as const;

export function projectSession(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return {};
  const out = pick(raw, SESSION_FIELDS);
  const principal = projectPrincipal(raw['principal']);
  if (principal) out['principal'] = principal;
  return out;
}

/** get_session wraps the session row and its summary; both narrow through
 * the same allowlist (the summary's fields are a subset: llm_activity,
 * sources, coverage, risk_max_severity, end_reason/end_detail). */
export function projectSessionWithSummary(session: unknown, summary: unknown): Record<string, unknown> {
  const out = projectSession(session);
  if (isRecord(summary)) Object.assign(out, projectSession(summary));
  return out;
}

const HOST_FIELDS = ['host', 'count', 'first_seen_at', 'last_seen_at', 'secure', 'scheme'] as const;

export function projectHost(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return {};
  return pick(raw, HOST_FIELDS);
}

const FINDING_FIELDS = [
  'finding_id', 'session_id', 'agent_id', 'tenant_id',
  'class', 'subtype', 'severity', 'status', 'reason_code',
  'observed_value', 'evidence_refs', 'created_at', 'summary',
] as const; // disposition.reason / actor_user_id dropped via projectDisposition

export function projectFinding(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return {};
  const out = pick(raw, FINDING_FIELDS);
  const disposition = projectDisposition(raw['disposition']);
  if (disposition) out['disposition'] = disposition;
  return out;
}

const BASELINE_FIELDS = [
  'baseline_id', 'agent_id', 'tenant_id', 'created_at', 'trained_at',
  'version', 'status', 'active', 'rules_version', 'session_count',
  'allowed_tools', 'allowed_domains', 'allowed_processes',
] as const;

export function projectBaseline(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return {};
  return pick(raw, BASELINE_FIELDS);
}

const SEARCH_RESULT_FIELDS = ['kind', 'value', 'agent_id', 'count', 'first_seen_at', 'last_seen_at'] as const;

export function projectSearchResult(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return {};
  return pick(raw, SEARCH_RESULT_FIELDS);
}
