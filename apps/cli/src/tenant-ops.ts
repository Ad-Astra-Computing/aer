/**
 * Thin wrappers over the tenant-auth HTTP API. Each function takes baseUrl +
 * apiKey + an optional fetch override (msw-friendly).
 */

export interface TenantOpts {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

function authHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` };
}

function authedFetch(opts: TenantOpts) {
  const f = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, '');
  return async (path: string, init?: RequestInit): Promise<unknown> => {
    const res = await f(`${base}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        authorization: `Bearer ${opts.apiKey}`,
      },
    });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    // 204s have no body
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
}

export async function listAgents(opts: TenantOpts): Promise<unknown> {
  return authedFetch(opts)('/v1/agents');
}

export async function createAgent(opts: TenantOpts & { name: string; frameworkType?: string }): Promise<unknown> {
  return authedFetch(opts)('/v1/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: opts.name,
      ...(opts.frameworkType ? { framework_type: opts.frameworkType } : {}),
    }),
  });
}

export async function listSessions(opts: TenantOpts & { agentId?: string; limit?: number; cursor?: string }): Promise<unknown> {
  const q = new URLSearchParams();
  if (opts.agentId) q.set('agent_id', opts.agentId);
  if (opts.limit) q.set('limit', String(opts.limit));
  if (opts.cursor) q.set('cursor', opts.cursor);
  const qs = q.toString();
  return authedFetch(opts)(`/v1/sessions${qs ? `?${qs}` : ''}`);
}

export async function getSession(opts: TenantOpts & { sessionId: string }): Promise<unknown> {
  return authedFetch(opts)(`/v1/sessions/${encodeURIComponent(opts.sessionId)}`);
}

export async function listFindings(opts: TenantOpts & { limit?: number; severity?: string }): Promise<unknown> {
  const q = new URLSearchParams();
  if (opts.limit) q.set('limit', String(opts.limit));
  if (opts.severity) q.set('severity', opts.severity);
  const qs = q.toString();
  return authedFetch(opts)(`/v1/findings${qs ? `?${qs}` : ''}`);
}

export async function findingsRollup(opts: TenantOpts & { days?: number; agentId?: string }): Promise<unknown> {
  const params = new URLSearchParams();
  if (opts.days) params.set('days', String(opts.days));
  if (opts.agentId) params.set('agent_id', opts.agentId);
  const qs = params.toString();
  return authedFetch(opts)(`/v1/findings/rollup${qs ? `?${qs}` : ''}`);
}

export async function listAudit(opts: TenantOpts & { limit?: number }): Promise<unknown> {
  const q = opts.limit ? `?limit=${opts.limit}` : '';
  return authedFetch(opts)(`/v1/audit${q}`);
}

export async function listAers(opts: TenantOpts & { limit?: number; cursor?: string }): Promise<unknown> {
  const q = new URLSearchParams();
  if (opts.limit) q.set('limit', String(opts.limit));
  if (opts.cursor) q.set('cursor', opts.cursor);
  const qs = q.toString();
  return authedFetch(opts)(`/v1/aers${qs ? `?${qs}` : ''}`);
}

export async function getAerMeta(opts: TenantOpts & { aerId: string }): Promise<unknown> {
  return authedFetch(opts)(`/v1/aers/${encodeURIComponent(opts.aerId)}`);
}

export async function getBaseline(opts: TenantOpts & { agentId: string }): Promise<unknown> {
  return authedFetch(opts)(`/v1/agents/${encodeURIComponent(opts.agentId)}/baseline`);
}

export async function retrainBaseline(opts: TenantOpts & {
  agentId: string;
  tenantId: string;
  lastN?: number;
  sessionIds?: string[];
}): Promise<unknown> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.baseUrl.replace(/\/$/, '')}/v1/agents/${encodeURIComponent(opts.agentId)}/baseline/retrain`, {
    method: 'POST',
    headers: { ...authHeaders(opts.apiKey), 'content-type': 'application/json' },
    body: JSON.stringify({
      tenant_id: opts.tenantId,
      ...(opts.lastN !== undefined ? { last_n: opts.lastN } : {}),
      ...(opts.sessionIds ? { session_ids: opts.sessionIds } : {}),
    }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}
