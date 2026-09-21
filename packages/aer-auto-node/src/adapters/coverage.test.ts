import { describe, it, expect } from 'vitest';
import { deriveCoverage, PROVIDER_HOSTS, countProviderTraffic } from './coverage.js';

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
