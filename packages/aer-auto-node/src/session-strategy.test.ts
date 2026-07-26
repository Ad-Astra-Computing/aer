import { describe, it, expect } from 'vitest';
import { createCollector } from './collector.js';
import { resolveConfig, type SessionStrategy } from './config.js';
import type { CollectorEvent, SessionTransport } from './session.js';

interface FakeT { transport: SessionTransport; emitted: CollectorEvent[]; log: string[] }
function fakeTransport(): FakeT {
  const emitted: CollectorEvent[] = [];
  const log: string[] = [];
  return {
    emitted, log,
    transport: {
      async open() { log.push('open'); },
      async emit(events) { emitted.push(...events); },
      async complete() { log.push('complete'); },
      async abort() { log.push('abort'); },
    },
  };
}

function cfg(strategy: SessionStrategy, requireTask = false) {
  return resolveConfig({ env: {}, configFile: { session: { strategy, requireTask } } });
}

const ev = (t: string): CollectorEvent => ({ event_type: t, payload: {} });

function collectorWith(strategy: SessionStrategy, requireTask = false) {
  const def = fakeTransport();
  const tasks: FakeT[] = [];
  const collector = createCollector(cfg(strategy, requireTask), {
    transport: def.transport,
    patchInstaller: false,
    adapterInstaller: false,
    sessionTransportFactory: () => { const t = fakeTransport(); tasks.push(t); return t.transport; },
  });
  return { collector, def, tasks };
}

describe('session strategies', () => {
  it('process: captures outside withAerSession go to the default session', async () => {
    const { collector, def } = collectorWith('process');
    collector.capture(ev('http.requested'));
    await collector.session.flush();
    expect(def.emitted.some((e) => e.event_type === 'http.requested')).toBe(true);
  });

  it('server: captures outside withAerSession are dropped (no default session opened)', async () => {
    const { collector, def } = collectorWith('server');
    collector.capture(ev('http.requested'));
    await new Promise((r) => setTimeout(r, 5));
    expect(def.log).not.toContain('open');
    expect(def.emitted).toHaveLength(0);
  });

  it('server: captures inside withAerSession go to a fresh per-task session that completes', async () => {
    const { collector, tasks } = collectorWith('server');
    const result = await collector.withSession({}, async () => {
      collector.capture(ev('http.requested'));
      return 42;
    });
    expect(result).toBe(42);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.log).toContain('open');
    expect(tasks[0]!.log).toContain('complete');
    expect(tasks[0]!.emitted.some((e) => e.event_type === 'http.requested')).toBe(true);
  });

  it('task with requireTask drops captures made outside a task', async () => {
    const { collector, def } = collectorWith('task', true);
    collector.capture(ev('http.requested'));
    await new Promise((r) => setTimeout(r, 5));
    expect(def.emitted).toHaveLength(0);
  });

  it('task without requireTask falls back to the default session outside a task', async () => {
    const { collector, def } = collectorWith('task', false);
    collector.capture(ev('http.requested'));
    await collector.session.flush();
    expect(def.emitted.some((e) => e.event_type === 'http.requested')).toBe(true);
  });

  it('withAerSession aborts the session and rethrows when the body throws', async () => {
    const { collector, tasks } = collectorWith('server');
    await expect(collector.withSession({}, async () => {
      collector.capture(ev('tool.selected'));
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(tasks[0]!.log).toContain('abort');
    expect(tasks[0]!.log).not.toContain('complete');
  });

  it('isolates concurrent tasks: each task\'s events go to its own session', async () => {
    const { collector, tasks } = collectorWith('server');
    await Promise.all([
      collector.withSession({}, async () => {
        collector.capture(ev('http.requested'));
        await new Promise((r) => setTimeout(r, 10));
        collector.capture(ev('http.completed'));
      }),
      collector.withSession({}, async () => {
        collector.capture(ev('process.exec'));
        await new Promise((r) => setTimeout(r, 5));
        collector.capture(ev('process.exit'));
      }),
    ]);
    expect(tasks).toHaveLength(2);
    const types = tasks.map((t) => new Set(t.emitted.map((e) => e.event_type)));
    // task A saw http.*, not process.*; task B the reverse
    const a = types.find((s) => s.has('http.requested'))!;
    const b = types.find((s) => s.has('process.exec'))!;
    expect(a.has('process.exec')).toBe(false);
    expect(b.has('http.requested')).toBe(false);
  });

  it('passes agentId override through to the per-task transport factory', async () => {
    let seen: unknown;
    const collector = createCollector(cfg('server'), {
      transport: fakeTransport().transport,
      patchInstaller: false,
      adapterInstaller: false,
      sessionTransportFactory: (opts) => { seen = opts; return fakeTransport().transport; },
    });
    await collector.withSession({ agentId: 'support-bot' }, async () => {
      collector.capture(ev('http.requested'));
    });
    expect(seen).toMatchObject({ agentId: 'support-bot' });
  });
});
