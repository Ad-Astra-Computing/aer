// A process that spawns worker threads gets one collector per thread, and so
// one signed record per thread. That is not wrong, but nothing in the records
// said they came from the same run, so a reader could not put them back
// together. A run id, set once and inherited, is what joins them.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveRunId, threadIdentity } from './run-id.js';

const KEY = 'AER_RUN_ID';
let saved: string | undefined;
beforeEach(() => { saved = process.env[KEY]; delete process.env[KEY]; });
afterEach(() => { if (saved === undefined) delete process.env[KEY]; else process.env[KEY] = saved; });

describe('resolveRunId', () => {
  it('mints one and exports it, so a child process inherits it', () => {
    const env: NodeJS.ProcessEnv = {};
    const id = resolveRunId(env);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(env[KEY]).toBe(id);
  });

  it('keeps an id it was given rather than starting a new run', () => {
    const env: NodeJS.ProcessEnv = { AER_RUN_ID: 'a'.repeat(32) };
    expect(resolveRunId(env)).toBe('a'.repeat(32));
  });

  it('replaces a value that is not one of ours', () => {
    // The variable is inherited from an environment we do not control, so a
    // junk or hostile value must not end up in a signed record.
    for (const bad of ['', 'not a run id', '../../etc/passwd', 'x'.repeat(500), 'A'.repeat(32)]) {
      const env: NodeJS.ProcessEnv = { AER_RUN_ID: bad };
      const id = resolveRunId(env);
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      expect(id).not.toBe(bad);
    }
  });

  it('gives two calls in one process the same id', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(resolveRunId(env)).toBe(resolveRunId(env));
  });
});

describe('threadIdentity', () => {
  it('marks the main thread as the main thread', () => {
    expect(threadIdentity()).toMatchObject({ main_thread: true, thread_id: 0 });
  });

  it('reports the pid, so records from separate processes stay separable', () => {
    expect(threadIdentity().pid).toBe(process.pid);
  });
});

describe('the collector report carries the linkage', () => {
  it('stamps the run id and the thread on every report', async () => {
    // Without this a reader sees several signed records for one run with
    // nothing in them saying they belong together.
    const { createCollector } = await import('./collector.js');
    const { resolveConfig } = await import('./config.js');
    const all: { event_type: string; payload: Record<string, unknown> }[] = [];
    const transport = {
      async open() {},
      async emit(events: typeof all) { all.push(...events); },
      async complete() {},
      async abort() {},
    } as never;

    const collector = createCollector(resolveConfig({ env: {} }), {
      transport, patchInstaller: false, adapterInstaller: false,
    });
    collector.capture({ event_type: 'http.requested', payload: { host: 'x', method: 'GET' } });
    await collector.session.flush();

    const reports = all.filter((e) => e.event_type === 'collector.report');
    expect(reports.length).toBeGreaterThan(0);
    for (const r of reports) {
      expect(r.payload['run_id']).toMatch(/^[0-9a-f]{32}$/);
      expect(r.payload['main_thread']).toBe(true);
      expect(r.payload['pid']).toBe(process.pid);
      expect(r.payload['thread_id']).toBe(0);
    }
    expect(new Set(reports.map((r) => r.payload['run_id'])).size).toBe(1);
  });
});
