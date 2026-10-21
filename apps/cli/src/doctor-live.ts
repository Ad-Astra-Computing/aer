import type { DoctorCheck, DoctorReport } from './init.js';
import { sanitizeForTerminal } from './cli-error.js';

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
    checks.push({ name: 'AER_BASE_URL', ok: false, detail: 'not set: export AER_BASE_URL=https://api.aer.run' });
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
      detail: res.ok ? 'ready (200)' : `not ready: HTTP ${res.status}. Check the API status page.`,
    });
  } catch (e) {
    checks.push({
      name: 'API reachable (/readyz)',
      ok: false,
      detail: `unreachable: ${(e as Error).message}. Verify AER_BASE_URL and network.`,
    });
  }

  // 3. Tenant auth via a harmless read (GET /v1/agents).
  let tenantAuthOk = false;
  if (!input.apiKey) {
    checks.push({ name: 'tenant auth', ok: false, detail: 'no API key: export AER_API_KEY (or AER_TENANT_API_KEY)' });
  } else if (!reachable) {
    checks.push({ name: 'tenant auth', ok: false, detail: 'skipped, API not reachable' });
  } else {
    try {
      const res = await fetchFn(`${baseUrl}/v1/agents`, { headers: { authorization: `Bearer ${input.apiKey}` } });
      if (res.ok) {
        tenantAuthOk = true;
        checks.push({ name: 'tenant auth', ok: true, detail: 'API key accepted (GET /v1/agents 200)' });
      } else if (res.status === 401 || res.status === 403) {
        checks.push({ name: 'tenant auth', ok: false, detail: `key rejected (HTTP ${res.status}). Check AER_API_KEY is a valid tenant key.` });
      } else {
        checks.push({ name: 'tenant auth', ok: false, detail: `unexpected HTTP ${res.status} from GET /v1/agents` });
      }
    } catch (e) {
      checks.push({ name: 'tenant auth', ok: false, detail: `request failed: ${(e as Error).message}` });
    }
  }

  // 4. Usage cap: GET /v1/usage already encodes the server's own judgment of
  // whether new sessions are allowed (it accounts for enforcement mode), so
  // this check reads new_sessions_allowed rather than re-deriving ok/fail
  // from state itself. Skipped (not failed) when tenant auth already failed:
  // a rejected key reported here too would be a duplicate of check 3, and
  // "unexpected HTTP 401" reads as a server problem rather than the
  // already-diagnosed bad key.
  if (!input.apiKey) {
    checks.push({ name: 'usage cap', ok: false, detail: 'no API key: export AER_API_KEY (or AER_TENANT_API_KEY)' });
  } else if (!reachable) {
    checks.push({ name: 'usage cap', ok: false, detail: 'skipped, API not reachable' });
  } else if (!tenantAuthOk) {
    checks.push({ name: 'usage cap', ok: false, detail: 'skipped, tenant auth already failed' });
  } else {
    try {
      const res = await fetchFn(`${baseUrl}/v1/usage`, { headers: { authorization: `Bearer ${input.apiKey}` } });
      if (res.ok) {
        const body = (await res.json()) as {
          state?: string;
          new_sessions_allowed?: boolean;
          blocked_reason?: string | null;
          events?: { used?: number; limit?: number; percent?: number };
          sessions?: { used?: number; limit?: number; percent?: number };
          upgrade?: { url?: string };
        };
        if (typeof body.new_sessions_allowed !== 'boolean') {
          checks.push({ name: 'usage cap', ok: false, detail: 'unrecognised response from GET /v1/usage (not a current AER API?)' });
        } else if (body.new_sessions_allowed) {
          checks.push({
            name: 'usage cap',
            ok: true,
            detail: `${sanitizeForTerminal(body.state ?? 'ok')} (${body.events?.percent ?? '?'}% events, ${body.sessions?.percent ?? '?'}% sessions)`,
          });
        } else {
          const unit = sanitizeForTerminal(body.blocked_reason ?? 'usage');
          const metric = body.blocked_reason === 'sessions' ? body.sessions : body.events;
          const used = metric?.used ?? '?';
          const limit = metric?.limit ?? '?';
          const upgradeUrl = body.upgrade?.url ? sanitizeForTerminal(body.upgrade.url) : undefined;
          checks.push({
            name: 'usage cap',
            ok: false,
            detail: `blocked on ${unit} (${used}/${limit}).${upgradeUrl ? ` Upgrade: ${upgradeUrl}` : ''}`,
          });
        }
      } else {
        checks.push({ name: 'usage cap', ok: false, detail: `unexpected HTTP ${res.status} from GET /v1/usage` });
      }
    } catch (e) {
      checks.push({ name: 'usage cap', ok: false, detail: `request failed: ${(e as Error).message}` });
    }
  }

  // 5. Optional: agent_id resolves for this tenant and is not paused.
  if (input.agentId) {
    if (!input.apiKey || !reachable) {
      checks.push({ name: 'agent_id', ok: false, detail: 'skipped, needs a reachable API and a valid key' });
    } else {
      try {
        const res = await fetchFn(`${baseUrl}/v1/agents`, { headers: { authorization: `Bearer ${input.apiKey}` } });
        if (res.ok) {
          const body = (await res.json()) as { agents?: Array<{ agent_id?: string; status?: string }> };
          const agent = (body.agents ?? []).find((a) => a.agent_id === input.agentId);
          if (!agent) {
            checks.push({ name: 'agent_id', ok: false, detail: `${input.agentId} not found for this tenant. Create it with \`aer agents create\` or check the id.` });
          } else if (agent.status === 'paused') {
            checks.push({ name: 'agent_id', ok: false, detail: `${input.agentId} is paused by the tenant operator; resume it in the console before running sessions.` });
          } else {
            checks.push({ name: 'agent_id', ok: true, detail: `${input.agentId} found` });
          }
        } else {
          checks.push({ name: 'agent_id', ok: false, detail: `could not list agents (HTTP ${res.status})` });
        }
      } catch (e) {
        checks.push({ name: 'agent_id', ok: false, detail: `request failed: ${(e as Error).message}` });
      }
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}
