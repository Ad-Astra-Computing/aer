import { describe, it, expect, vi } from 'vitest';
import { fetchUsagePolicy } from './policy-fetch.js';

const OK_POLICY = {
  policy_id: '01950000-0000-7000-8000-000000000001',
  agent_id: '01950000-0000-7000-8000-000000000002',
  version: 4,
  mode: 'block',
  on_unavailable: 'fail_closed',
  llm: { denied_models: ['*-vision'], max_calls_per_session: 50 },
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('fetchUsagePolicy', () => {
  it('GETs the agent usage-policy with the tenant bearer token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, OK_POLICY));
    const policy = await fetchUsagePolicy({
      baseUrl: 'https://aer-api.example.com/',
      agentId: 'agent-1',
      apiKey: 'secret-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://aer-api.example.com/v1/agents/agent-1/usage-policy');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer secret-key');
    expect(policy).toMatchObject({ policy_id: OK_POLICY.policy_id, version: 4, mode: 'block' });
    expect(policy?.llm?.denied_models).toEqual(['*-vision']);
  });

  it('returns null on 404 (no policy configured)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { error: 'not_found' }));
    const policy = await fetchUsagePolicy({
      baseUrl: 'https://x', agentId: 'a', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(policy).toBeNull();
  });

  it('returns null on a network error (fail-open: no mode known)', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const policy = await fetchUsagePolicy({
      baseUrl: 'https://x', agentId: 'a', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(policy).toBeNull();
  });

  it('returns null on a non-2xx / non-404 status', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: 'boom' }));
    const policy = await fetchUsagePolicy({
      baseUrl: 'https://x', agentId: 'a', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(policy).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    const bad = { ...jsonResponse(200, {}), json: async () => { throw new Error('bad json'); } } as unknown as Response;
    const fetchImpl = vi.fn(async () => bad);
    const policy = await fetchUsagePolicy({
      baseUrl: 'https://x', agentId: 'a', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(policy).toBeNull();
  });

  it('returns null when required fields are missing / wrong type', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { mode: 'block' })); // no policy_id/version
    const policy = await fetchUsagePolicy({
      baseUrl: 'https://x', agentId: 'a', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(policy).toBeNull();
  });

  it('coerces an unknown mode to off (disabled) rather than trusting it', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ...OK_POLICY, mode: 'nonsense' }));
    const policy = await fetchUsagePolicy({
      baseUrl: 'https://x', agentId: 'a', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(policy?.mode).toBe('off');
  });

  it('returns null when no agentId is configured', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, OK_POLICY));
    const policy = await fetchUsagePolicy({
      baseUrl: 'https://x', agentId: undefined, apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(policy).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
