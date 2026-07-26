import { describe, it, expect } from 'vitest';
import { createCollector } from './collector.js';
import { resolveConfig } from './config.js';
import { AdapterStats } from './adapters/index.js';
import { installFetchPatch } from './patches/fetch.js';
import type { CollectorEvent, SessionTransport } from './session.js';

function recordingTransport(): { transport: SessionTransport; emitted: () => CollectorEvent[] } {
  const all: CollectorEvent[] = [];
  return {
    transport: {
      async open() {},
      async emit(events) { all.push(...events); },
      async complete() {},
      async abort() {},
    },
    emitted: () => all,
  };
}

describe('createCollector', () => {
  it('emits a session.started / dependency.snapshot / collector.report preamble before captured events', async () => {
    const { transport, emitted } = recordingTransport();
    const config = resolveConfig({ env: {}, configFile: { agent_id: 'a-1' } });
    const collector = createCollector(config, { transport, patchInstaller: false, adapterInstaller: false });

    collector.capture({ event_type: 'http.requested', payload: { host: 'api.openai.com', method: 'POST' } });
    await collector.session.flush();

    const types = emitted().map((e) => e.event_type);
    expect(types).toEqual([
      'session.started',
      'dependency.snapshot',
      'collector.report',
      'http.requested',
    ]);
  });

  it('the dependency.snapshot carries the node runtime and version', async () => {
    const { transport, emitted } = recordingTransport();
    const collector = createCollector(resolveConfig({ env: {} }), { transport, patchInstaller: false, adapterInstaller: false });
    collector.capture({ event_type: 'process.exec', payload: { command: 'git' } });
    await collector.session.flush();

    const snap = emitted().find((e) => e.event_type === 'dependency.snapshot');
    expect(snap?.payload['runtime']).toBe('node');
    expect(typeof snap?.payload['node_version']).toBe('string');
  });

  it('the collector.report names the collector and its session strategy', async () => {
    const { transport, emitted } = recordingTransport();
    const collector = createCollector(resolveConfig({ env: {} }), { transport, patchInstaller: false, adapterInstaller: false });
    collector.capture({ event_type: 'http.requested', payload: { host: 'x', method: 'GET' } });
    await collector.session.flush();

    const report = emitted().find((e) => e.event_type === 'collector.report');
    expect(report?.payload['collector']).toBe('@adastracomputing/aer-auto-node');
    expect(report?.payload['session_strategy']).toBe('process');
    expect(report?.payload['capture_policy']).toMatchObject({ bodies: 'off', headers: 'off' });
  });

  it('reports enabled_patches from the patch installer', async () => {
    const { transport, emitted } = recordingTransport();
    const collector = createCollector(resolveConfig({ env: {} }), {
      transport,
      patchInstaller: () => ({ enabled: ['fetch', 'http', 'https', 'child_process'], uninstall: () => {} }),
      adapterInstaller: false,
    });
    expect(collector.enabledPatches).toEqual(['fetch', 'http', 'https', 'child_process']);

    collector.capture({ event_type: 'http.requested', payload: { host: 'x', method: 'GET' } });
    await collector.session.flush();
    const report = emitted().find((e) => e.event_type === 'collector.report');
    expect(report?.payload['enabled_patches']).toEqual(['fetch', 'http', 'https', 'child_process']);
  });

  it('reports enabled_adapters from the adapter installer', async () => {
    const { transport, emitted } = recordingTransport();
    const collector = createCollector(resolveConfig({ env: {} }), {
      transport,
      patchInstaller: false,
      adapterInstaller: () => ({ enabled: ['openai', 'anthropic'], uninstall: () => {} }),
    });
    expect(collector.enabledAdapters).toEqual(['openai', 'anthropic']);

    collector.capture({ event_type: 'llm.requested', payload: { provider: 'openai', model: 'gpt-4o' } });
    await collector.session.flush();
    const report = emitted().find((e) => e.event_type === 'collector.report');
    expect(report?.payload['enabled_adapters']).toEqual(['openai', 'anthropic']);
  });

  it('the final collector.report carries per-provider adapter_activity counters', async () => {
    const { transport, emitted } = recordingTransport();
    const stats = new AdapterStats();
    const collector = createCollector(resolveConfig({ env: {} }), {
      transport,
      patchInstaller: false,
      adapterInstaller: () => ({ enabled: ['openai'], uninstall: () => {}, stats }),
    });

    // Simulate two openai calls (one with a tool selection) flowing through the
    // shared stats while the session is live.
    stats.record('openai', 'call');
    stats.record('openai', 'ok');
    stats.record('openai', 'tool');
    stats.record('openai', 'call');
    stats.record('openai', 'error');

    collector.capture({ event_type: 'llm.requested', payload: { provider: 'openai', model: 'gpt-4o' } });
    await collector.complete();

    const reports = emitted().filter((e) => e.event_type === 'collector.report');
    const final = reports[reports.length - 1];
    expect(final?.payload['phase']).toBe('final');
    expect(final?.payload['adapter_activity']).toEqual({
      openai: { calls: 2, ok: 1, error: 1, tool_selections: 1 },
    });
  });

  it('omits adapter_activity when no adapter recorded any activity', async () => {
    const { transport, emitted } = recordingTransport();
    const collector = createCollector(resolveConfig({ env: {} }), {
      transport,
      patchInstaller: false,
      adapterInstaller: () => ({ enabled: ['openai'], uninstall: () => {}, stats: new AdapterStats() }),
    });
    collector.capture({ event_type: 'http.requested', payload: { host: 'x', method: 'GET' } });
    await collector.complete();

    const reports = emitted().filter((e) => e.event_type === 'collector.report');
    const final = reports[reports.length - 1];
    expect(final?.payload['adapter_activity']).toBeUndefined();
  });

  it('complete() emits a closing collector.report and completes', async () => {
    const { transport, emitted } = recordingTransport();
    const collector = createCollector(resolveConfig({ env: {} }), { transport, patchInstaller: false, adapterInstaller: false });
    collector.capture({ event_type: 'http.requested', payload: { host: 'x', method: 'GET' } });
    await collector.complete();

    const reports = emitted().filter((e) => e.event_type === 'collector.report');
    expect(reports.length).toBeGreaterThanOrEqual(2); // opening + closing
    expect(reports[reports.length - 1]?.payload['phase']).toBe('final');
  });

  it('ships the configured principal on the create-session body, and withSession overrides it', async () => {
    const originalFetch = globalThis.fetch;
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/v1/sessions')) {
        bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return new Response(JSON.stringify({ agent_session_id: 's1', ingest_token: 't1' }), { status: 201 });
      }
      return new Response(JSON.stringify({ accepted: 0, rejected: 0, errors: [] }), { status: 202 });
    }) as unknown as typeof fetch;
    try {
      const config = resolveConfig({
        env: {
          AER_API_KEY: 'k', AER_BASE_URL: 'https://aer-api.test',
          AER_PRINCIPAL_ID: 'emp-77', AER_PRINCIPAL_KIND: 'user', AER_PRINCIPAL_DISPLAY: 'Grace H.',
        },
        configFile: { tenant_id: 't', agent_id: 'a', env_id: 'e' },
      });
      const collector = createCollector(config, { patchInstaller: false, adapterInstaller: false });

      // Default session uses the process-wide principal.
      await collector.withSession({}, async () => {
        collector.capture({ event_type: 'custom.marker', payload: {} });
      });
      // withSession override wins for this task's session.
      await collector.withSession({ principal: { id: 'svc-1', kind: 'service' } }, async () => {
        collector.capture({ event_type: 'custom.marker', payload: {} });
      });

      expect(bodies[0]?.['principal']).toEqual({ id: 'emp-77', kind: 'user', display: 'Grace H.' });
      expect(bodies[1]?.['principal']).toEqual({ id: 'svc-1', kind: 'service' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not re-instrument its own wire traffic under a live fetch patch (no self-capture loop)', async () => {
    // Regression for the withSession self-instrumentation loop: a withSession
    // transport is built AFTER the global fetch patch installs, so it must still
    // send over the PRISTINE fetch — never the patched one — or the collector's
    // own /events POSTs would be captured as http.requested and loop.
    const originalFetch = globalThis.fetch;
    const g = globalThis as Record<symbol, unknown>;
    const wireEvents: Array<{ type: string; host: unknown }> = [];

    // The pristine fetch (set before createCollector snapshots it) is the fake AER API.
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/v1/sessions')) {
        return new Response(JSON.stringify({ agent_session_id: 's1', ingest_token: 't1' }), { status: 201 });
      }
      if (u.includes('/events')) {
        const body = JSON.parse(String(init?.body ?? '[]')) as Array<{ event_type: string; payload: Record<string, unknown> }>;
        for (const e of body) wireEvents.push({ type: e.event_type, host: e.payload?.['host'] });
        return new Response(JSON.stringify({ accepted: body.length, rejected: 0, errors: [] }), { status: 202 });
      }
      return new Response('{}', { status: 200 }); // complete/abort
    }) as unknown as typeof fetch;

    try {
      const config = resolveConfig({
        env: { AER_API_KEY: 'k', AER_BASE_URL: 'https://aer-api.test' },
        configFile: { tenant_id: 't', agent_id: 'a', env_id: 'e' },
      });
      const collector = createCollector(config, {
        // Real fetch patch: its capture routes back into the collector.
        patchInstaller: (capture) => ({ enabled: ['fetch'], uninstall: installFetchPatch((e) => capture(e)) }),
        adapterInstaller: false,
      });

      // withSession builds its transport AFTER the patch above is installed.
      await collector.withSession({}, async () => {
        collector.capture({ event_type: 'custom.marker', payload: {} });
      });

      // None of the emitted events may be an http.requested for the AER host —
      // that would mean the transport's own POSTs were re-instrumented.
      const selfCaptures = wireEvents.filter(
        (e) => e.type === 'http.requested' && String(e.host).includes('aer-api.test'),
      );
      expect(selfCaptures).toEqual([]);
      // Sanity: the session actually shipped its marker over the wire.
      expect(wireEvents.some((e) => e.type === 'custom.marker')).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      delete g[Symbol.for('adastra.aer.patched.fetch')];
      delete g[Symbol.for('adastra.aer.original.fetch')];
    }
  });
});
