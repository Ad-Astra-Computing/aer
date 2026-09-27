import { describe, it, expect } from 'vitest';
import {
  deriveCoverage,
  PROVIDER_HOSTS,
  countProviderTraffic,
  adapterRows,
  looksLikeModelCall,
} from './coverage.js';

describe('deriveCoverage', () => {
  it('confirms an adapter that recorded calls', () => {
    expect(deriveCoverage({ status: 'patched', callsRecorded: 3, providerTraffic: 3, transportWatching: true }))
      .toBe('confirmed');
  });

  it('contradicts an adapter that recorded nothing while its provider was called', () => {
    // The exact failure this exists for: the collector said it was
    // instrumenting openai, the transport saw traffic to api.openai.com, and
    // no llm event was ever recorded.
    expect(deriveCoverage({ status: 'patched', callsRecorded: 0, providerTraffic: 4, transportWatching: true }))
      .toBe('contradicted');
  });

  it('calls a quiet adapter idle, not broken', () => {
    expect(deriveCoverage({ status: 'patched', callsRecorded: 0, providerTraffic: 0, transportWatching: true }))
      .toBe('idle');
  });

  it('will not judge when the transport is not watching', () => {
    // Without the http/fetch patches there is no evidence either way, and a
    // guess in a signed record is worse than an admission.
    expect(deriveCoverage({ status: 'patched', callsRecorded: 0, providerTraffic: 0, transportWatching: false }))
      .toBe('unverifiable');
  });

  it('still confirms on recorded calls even with no transport', () => {
    expect(deriveCoverage({ status: 'patched', callsRecorded: 2, providerTraffic: 0, transportWatching: false }))
      .toBe('confirmed');
  });

  it('does not claim coverage for an adapter that never installed', () => {
    for (const status of ['absent', 'failed', 'unsupported'] as const) {
      expect(deriveCoverage({ status, callsRecorded: 0, providerTraffic: 5, transportWatching: true }))
        .toBe('unverifiable');
    }
  });

  it('reports a patch that was replaced after we installed it', () => {
    // Another agent, or the app itself, overwrote the method. Calls after
    // that point were never seen, so recorded calls do not settle it.
    expect(deriveCoverage({ status: 'patched', callsRecorded: 1, providerTraffic: 9, transportWatching: true, patchIntact: false }))
      .toBe('contradicted');
  });
});

describe('countProviderTraffic', () => {
  const events = [
    { event_type: 'http.requested', payload: { host: 'api.openai.com' } },
    { event_type: 'http.requested', payload: { host: 'api.openai.com' } },
    { event_type: 'http.requested', payload: { host: 'api.anthropic.com' } },
    { event_type: 'http.completed', payload: { host: 'api.openai.com' } },
    { event_type: 'http.requested', payload: { host: 'example.com' } },
    { event_type: 'llm.requested', payload: { model: 'm' } },
  ];

  it('counts requests to a provider, not responses or anything else', () => {
    expect(countProviderTraffic(events, 'openai')).toBe(2);
    expect(countProviderTraffic(events, 'anthropic')).toBe(1);
  });

  it('counts a host with a port, which is how the transport records one', () => {
    expect(countProviderTraffic([{ event_type: 'http.requested', payload: { host: 'api.openai.com:443' } }], 'openai'))
      .toBe(1);
  });

  it('counts nothing for a custom base url, so the verdict stays unverifiable', () => {
    expect(countProviderTraffic([{ event_type: 'http.requested', payload: { host: '127.0.0.1:8080' } }], 'openai'))
      .toBe(0);
  });

  it('is not fooled by a lookalike host', () => {
    for (const host of ['api.openai.com.evil.test', 'notapi.openai.com', 'api-openai.com']) {
      expect(countProviderTraffic([{ event_type: 'http.requested', payload: { host } }], 'openai')).toBe(0);
    }
  });

  it('knows a host for every adapter it can judge', () => {
    for (const name of ['openai', 'anthropic']) {
      expect(PROVIDER_HOSTS[name]?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('a host two adapters could have called settles nothing', () => {
  // vercel-provider lists api.openai.com because a Vercel app can reach it,
  // and so does the openai adapter. An app using the openai SDK directly
  // produced a vercel-provider row of `contradicted`: a coverage failure
  // asserted in a signed record that did not happen.
  it('does not contradict an adapter over a host another one owns', () => {
    const traffic = [{ event_type: 'http.requested', payload: { host: 'api.openai.com' } }];
    const rows = adapterRows({
      patched: ['openai', 'vercel-provider'],
      configured: ['openai', 'vercel-provider'],
      calls: { openai: 2 },
      events: traffic,
      transportWatching: true,
    });
    expect(rows.find((r) => r.name === 'openai')?.coverage).toBe('confirmed');
    expect(rows.find((r) => r.name === 'vercel-provider')?.coverage).toBe('unverifiable');
  });

  it('still contradicts when the host belongs to that adapter alone', () => {
    const rows = adapterRows({
      patched: ['openai'],
      configured: ['openai'],
      calls: {},
      events: [{ event_type: 'http.requested', payload: { host: 'api.openai.com' } }],
      transportWatching: true,
    });
    expect(rows.find((r) => r.name === 'openai')?.coverage).toBe('contradicted');
  });

  it('counts a shared host as traffic for the adapter that recorded it', () => {
    const rows = adapterRows({
      patched: ['openai', 'vercel-provider'],
      configured: ['openai', 'vercel-provider'],
      calls: { 'vercel-provider': 1 },
      events: [{ event_type: 'http.requested', payload: { host: 'api.anthropic.com' } }],
      transportWatching: true,
    });
    expect(rows.find((r) => r.name === 'vercel-provider')?.coverage).toBe('confirmed');
  });
});

// An adapter that recorded nothing while the session made calls to hosts no
// adapter claims is not a quiet adapter: it is a session we cannot vouch for.
// ai@7 routes a bare string model id through @ai-sdk/gateway, and a custom
// baseURL (Azure, Bedrock, Vertex, a corporate proxy) does the same thing, so
// `idle` was a signed assertion that no model traffic happened when it had.
describe('idle requires that nothing unattributed went out', () => {
  const quiet = {
    status: 'patched' as const,
    callsRecorded: 0,
    providerTraffic: 0,
    transportWatching: true,
  };

  it('stays idle when the session made no unattributed calls', () => {
    expect(deriveCoverage({ ...quiet, unattributedTraffic: 0 })).toBe('idle');
  });

  it('will not call an adapter idle when traffic went somewhere we cannot attribute', () => {
    expect(deriveCoverage({ ...quiet, unattributedTraffic: 3 })).toBe('unverifiable');
  });

  it('still confirms when the adapter recorded calls, whatever else went out', () => {
    expect(deriveCoverage({ ...quiet, callsRecorded: 2, unattributedTraffic: 9 })).toBe('confirmed');
  });

  it('still contradicts on the adapter own provider traffic, which is the stronger claim', () => {
    expect(deriveCoverage({ ...quiet, providerTraffic: 1, unattributedTraffic: 9 })).toBe('contradicted');
  });

  it('treats a missing count as nothing unattributed, so old callers are unchanged', () => {
    expect(deriveCoverage(quiet)).toBe('idle');
  });
});

describe('a model call is recognised by its shape, not its vendor', () => {
  it('knows the endpoints every provider and proxy actually uses', () => {
    for (const path of [
      '/v1/chat/completions',
      '/openai/deployments/gpt-4o/chat/completions?<redacted>',
      '/v1/messages',
      '/v1/responses',
      '/v1beta/models/gemini-2.0-flash:generateContent',
      '/v1beta/models/gemini-2.0-flash:streamGenerateContent',
      '/model/anthropic.claude-sonnet-4-5/invoke-with-response-stream',
      '/v1/ai/language-model',
    ]) {
      expect(looksLikeModelCall(path)).toBe(true);
    }
  });

  it('does not mistake ordinary traffic for a model call', () => {
    for (const path of [
      '/simple/requests',
      '/Ad-Astra-Computing/aer.git/info/refs?<redacted>',
      '/v1/sessions/abc/events',
      '/healthz',
      '/',
      '',
      undefined,
    ]) {
      expect(looksLikeModelCall(path)).toBe(false);
    }
  });
});

describe('adapterRows counts traffic no adapter claims', () => {
  // The collector's own shape: the path is judged in the patch and only the
  // verdict reaches adapterRows.
  const req = (host: string, path = '/v1/chat/completions') => ({
    event_type: 'http.requested',
    payload: looksLikeModelCall(path) ? { host, model_shaped: true } : { host },
  });

  it('will not call the vercel adapter idle when the gateway was used', () => {
    // `generateText({ model: 'anthropic/claude-sonnet-4-5' })` goes to the
    // gateway, not to api.anthropic.com, and our provider patch never sees it.
    const rows = adapterRows({
      patched: ['vercel-provider'],
      configured: ['vercel-provider'],
      calls: {},
      events: [req('ai-gateway.vercel.sh', '/v1/ai/language-model')],
      transportWatching: true,
    });
    expect(rows[0]?.coverage).toBe('unverifiable');
  });

  it('will not call an adapter idle when a custom base url was used', () => {
    const rows = adapterRows({
      patched: ['openai'],
      configured: ['openai'],
      calls: {},
      events: [req('my-team.openai.azure.com', '/openai/deployments/gpt-4o/chat/completions')],
      transportWatching: true,
    });
    expect(rows[0]?.coverage).toBe('unverifiable');
  });

  it('keeps a genuinely quiet session idle', () => {
    // Traffic that is plainly not a model endpoint must not drag every adapter
    // to unverifiable, or the verdict stops meaning anything.
    const rows = adapterRows({
      patched: ['openai'],
      configured: ['openai'],
      calls: {},
      events: [req('registry.npmjs.org', '/aer/-/aer-1.0.0.tgz'), req('github.com', '/org/repo')],
      transportWatching: true,
    });
    expect(rows[0]?.coverage).toBe('idle');
  });

  it('does not hold an adapter answerable for a model host another adapter owns', () => {
    // api.anthropic.com is claimed by the patched anthropic adapter, so it is
    // that adapter own traffic and never unattributed for anyone else.
    const rows = adapterRows({
      patched: ['openai', 'anthropic'],
      configured: ['openai', 'anthropic'],
      calls: { anthropic: 1 },
      events: [req('api.anthropic.com', '/v1/messages')],
      transportWatching: true,
    });
    const openai = rows.find((r) => r.name === 'openai');
    expect(openai?.coverage).toBe('idle');
  });
});
