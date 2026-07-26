import type { DoctorCheck, DoctorReport } from './init.js';

// Live connectivity + auth checks for `aer doctor`. Package-independent: pure
// HTTP, no @adastracomputing/aer-auto-node import. Verifies the API is reachable and the
// tenant key is accepted, with exact remediation on each failure. Network errors
// become failing checks, never thrown.

export interface LiveDoctorInput {
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  agentId?: string | undefined;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
}

function trimUrl(u: string): string {
  return u.replace(/\/+$/, '');
}

export async function runLiveChecks(input: LiveDoctorInput): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const fetchFn = input.fetchFn ?? fetch;

  // 1. Base URL configured.
  const baseUrl = input.baseUrl ? trimUrl(input.baseUrl) : '';
  if (!baseUrl) {
    checks.push({ name: 'AER_BASE_URL', ok: false, detail: 'not set — export AER_BASE_URL=https://api.aer.run' });
    return { ok: false, checks }; // nothing else can run without a base URL
  }
  checks.push({ name: 'AER_BASE_URL', ok: true, detail: baseUrl });

  // 2. API reachable + ready (DB + R2).
  let reachable = false;
  try {
    const res = await fetchFn(`${baseUrl}/readyz`, { method: 'GET' });
    reachable = res.ok;
    checks.push({
      name: 'API reachable (/readyz)',
      ok: res.ok,
      detail: res.ok ? 'ready (200)' : `not ready — HTTP ${res.status}; check the API status page`,
    });
  } catch (e) {
    checks.push({
      name: 'API reachable (/readyz)',
      ok: false,
      detail: `unreachable — ${(e as Error).message}; verify AER_BASE_URL and network`,
    });
  }

  // 3. Tenant auth via a harmless read (GET /v1/agents).
  if (!input.apiKey) {
    checks.push({ name: 'tenant auth', ok: false, detail: 'no API key — export AER_API_KEY (or AER_TENANT_API_KEY)' });
  } else if (!reachable) {
    checks.push({ name: 'tenant auth', ok: false, detail: 'skipped — API not reachable' });
  } else {
    try {
      const res = await fetchFn(`${baseUrl}/v1/agents`, { headers: { authorization: `Bearer ${input.apiKey}` } });
      if (res.ok) {
        checks.push({ name: 'tenant auth', ok: true, detail: 'API key accepted (GET /v1/agents 200)' });
      } else if (res.status === 401 || res.status === 403) {
        checks.push({ name: 'tenant auth', ok: false, detail: `key rejected (HTTP ${res.status}) — check AER_API_KEY is a valid tenant key` });
      } else {
        checks.push({ name: 'tenant auth', ok: false, detail: `unexpected HTTP ${res.status} from GET /v1/agents` });
      }
    } catch (e) {
      checks.push({ name: 'tenant auth', ok: false, detail: `request failed — ${(e as Error).message}` });
    }
  }

  // 4. Optional: agent_id resolves for this tenant.
  if (input.agentId) {
    if (!input.apiKey || !reachable) {
      checks.push({ name: 'agent_id', ok: false, detail: 'skipped — needs a reachable API and a valid key' });
    } else {
      try {
        const res = await fetchFn(`${baseUrl}/v1/agents`, { headers: { authorization: `Bearer ${input.apiKey}` } });
        if (res.ok) {
          const body = (await res.json()) as { agents?: Array<{ agent_id?: string }> };
          const found = (body.agents ?? []).some((a) => a.agent_id === input.agentId);
          checks.push({
            name: 'agent_id',
            ok: found,
            detail: found ? `${input.agentId} found` : `${input.agentId} not found for this tenant — create it with \`aer agents create\` or check the id`,
          });
        } else {
          checks.push({ name: 'agent_id', ok: false, detail: `could not list agents (HTTP ${res.status})` });
        }
      } catch (e) {
        checks.push({ name: 'agent_id', ok: false, detail: `request failed — ${(e as Error).message}` });
      }
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}
