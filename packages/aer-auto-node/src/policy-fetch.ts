// Best-effort fetch of the agent's usage policy at session open.
//
// GET ${baseUrl}/v1/agents/${agentId}/usage-policy with the tenant API key. This
// MUST NEVER throw or block session open: any failure (network, non-2xx,
// malformed) yields null, which disables enforcement (fail-open). A fetch you
// could not complete has no mode, and this feature is a cost control not a
// security boundary, so the default on any fetch failure is fail-open.
//
// The caller passes a PRISTINE fetch (the collector's stashed pre-patch fetch)
// so the policy fetch never re-instruments the collector's own traffic.

import type { PolicyMode, UsagePolicy, UsagePolicyLlm } from './policy.js';

export interface FetchUsagePolicyOptions {
  baseUrl: string;
  agentId?: string | undefined;
  apiKey?: string | undefined;
  fetchImpl?: typeof fetch;
  /** Time-bound the fetch so it never stalls session open. Default 3000ms. */
  timeoutMs?: number;
}

const VALID_MODES: readonly PolicyMode[] = ['off', 'report', 'block'];

/**
 * Fetch + parse the agent's usage policy. Returns the policy, or null when there
 * is no policy (404) or the fetch could not be completed / parsed (fail-open).
 * Never throws.
 */
export async function fetchUsagePolicy(opts: FetchUsagePolicyOptions): Promise<UsagePolicy | null> {
  const agentId = opts.agentId;
  if (!agentId) return null; // no agent → no policy to fetch
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl.replace(/\/$/, '');
  const url = `${baseUrl}/v1/agents/${encodeURIComponent(agentId)}/usage-policy`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 3000);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${opts.apiKey ?? ''}` },
      signal: controller.signal,
    });
    if (res.status === 404) return null; // no policy configured → disabled
    if (!res.ok) return null; // any other non-2xx → fail-open
    const json = (await res.json()) as unknown;
    return parsePolicy(json);
  } catch {
    return null; // network error / abort / malformed → fail-open
  } finally {
    clearTimeout(timeout);
  }
}

function parsePolicy(json: unknown): UsagePolicy | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  const policyId = o['policy_id'];
  const version = o['version'];
  if (typeof policyId !== 'string' || typeof version !== 'number') return null;
  // Trust nothing from the wire: an unrecognized mode disables enforcement.
  const rawMode = o['mode'];
  const mode: PolicyMode = VALID_MODES.includes(rawMode as PolicyMode) ? (rawMode as PolicyMode) : 'off';
  const onUnavailable = o['on_unavailable'] === 'fail_closed' ? 'fail_closed' : 'fail_open';
  const llm = parseLlm(o['llm']);
  return {
    policy_id: policyId,
    version,
    mode,
    on_unavailable: onUnavailable,
    ...(llm ? { llm } : {}),
  };
}

function parseLlm(raw: unknown): UsagePolicyLlm | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const out: UsagePolicyLlm = {};
  const allowed = stringArray(o['allowed_models']);
  const denied = stringArray(o['denied_models']);
  if (allowed) out.allowed_models = allowed;
  if (denied) out.denied_models = denied;
  if (typeof o['max_tokens_per_session'] === 'number') out.max_tokens_per_session = o['max_tokens_per_session'];
  if (typeof o['max_calls_per_session'] === 'number') out.max_calls_per_session = o['max_calls_per_session'];
  return Object.keys(out).length > 0 ? out : undefined;
}

function stringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((v): v is string => typeof v === 'string');
  return out.length > 0 ? out : undefined;
}
