import { describe, it, expect, vi } from 'vitest';
import { sinkFromEnv } from './env.js';
import { NullSink } from './sink.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('sinkFromEnv', () => {
  it('returns a NullSink with no relevant env', () => {
    expect(sinkFromEnv({})).toBeInstanceOf(NullSink);
  });

  it('returns a NullSink when API key present but identity missing', () => {
    expect(sinkFromEnv({ AER_API_KEY: 'k' })).toBeInstanceOf(NullSink);
    expect(sinkFromEnv({ AER_API_KEY: 'k', AER_TENANT_ID: 't' })).toBeInstanceOf(NullSink);
  });

  it('returns an http sink when API key + tenant + agent are present', () => {
    const sink = sinkFromEnv({ AER_API_KEY: 'k', AER_TENANT_ID: 't', AER_AGENT_ID: 'a' });
    expect(sink).not.toBeInstanceOf(NullSink);
    expect(typeof sink.emit).toBe('function');
  });

  it('accepts AER_TENANT_API_KEY as a fallback for AER_API_KEY', () => {
    const sink = sinkFromEnv({ AER_TENANT_API_KEY: 'k', AER_TENANT_ID: 't', AER_AGENT_ID: 'a' });
    expect(sink).not.toBeInstanceOf(NullSink);
  });

  it('prefers AER_API_KEY over AER_TENANT_API_KEY when both are set', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.body && url.endsWith('/v1/sessions')) bodies.push(JSON.parse(String(init.body)));
      if (url.endsWith('/v1/sessions')) return jsonResponse({ id: 's', ingest_token: 'tok' });
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const sink = sinkFromEnv(
      { AER_API_KEY: 'primary', AER_TENANT_API_KEY: 'fallback', AER_TENANT_ID: 't', AER_AGENT_ID: 'a' },
      { fetch: fakeFetch, batchSize: 1 },
    );
    sink.emit('tool.started', {});
    await sink.close();

    const authHeader = fakeFetch.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(authHeader?.['Authorization'] ?? authHeader?.['authorization']).toContain('primary');
  });

  it('forwards principal and identity from env on session open', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.body && url.endsWith('/v1/sessions')) bodies.push(JSON.parse(String(init.body)));
      if (url.endsWith('/v1/sessions')) return jsonResponse({ id: 's', ingest_token: 'tok' });
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const sink = sinkFromEnv(
      {
        AER_API_KEY: 'k',
        AER_TENANT_ID: 't',
        AER_AGENT_ID: 'a',
        AER_ENV_ID: 'prod',
        AER_AGENT_VERSION: 'v2',
        AER_PRINCIPAL_ID: 'emp-77',
        AER_PRINCIPAL_KIND: 'user',
        AER_PRINCIPAL_DISPLAY: 'Grace H.',
      },
      { fetch: fakeFetch, batchSize: 1 },
    );
    sink.emit('tool.started', {});
    await sink.close();

    expect(bodies[0]?.['environment_id']).toBe('prod');
    expect(bodies[0]?.['agent_version']).toBe('v2');
    expect(bodies[0]?.['principal']).toEqual({ id: 'emp-77', kind: 'user', display: 'Grace H.' });
  });
});
