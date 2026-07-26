import { describe, it, expect, vi } from 'vitest';
import { createSessionManager, type SessionTransport, type CollectorEvent } from './session.js';

interface Recorded { kind: 'open' | 'emit' | 'complete' | 'abort'; events?: CollectorEvent[] }

function fakeTransport(over: Partial<SessionTransport> = {}): {
  transport: SessionTransport;
  log: Recorded[];
  emitted: () => CollectorEvent[];
} {
  const log: Recorded[] = [];
  const transport: SessionTransport = {
    async open() { log.push({ kind: 'open' }); },
    async emit(events) { log.push({ kind: 'emit', events }); },
    async complete() { log.push({ kind: 'complete' }); },
    async abort() { log.push({ kind: 'abort' }); },
    ...over,
  };
  return { transport, log, emitted: () => log.filter((r) => r.kind === 'emit').flatMap((r) => r.events ?? []) };
}

const preamble = (): CollectorEvent[] => [
  { event_type: 'session.started', payload: { agent: 'demo' } },
  { event_type: 'dependency.snapshot', payload: { runtime: 'node' } },
  { event_type: 'collector.report', payload: { collector: '@adastracomputing/aer-auto-node' } },
];

function ev(type: string): CollectorEvent {
  return { event_type: type, payload: {} };
}

describe('createSessionManager (process strategy)', () => {
  it('does not open a session until the first event is captured (lazy)', async () => {
    const { transport, log } = fakeTransport();
    const mgr = createSessionManager({ transport, preamble });
    expect(mgr.state).toBe('idle');
    await Promise.resolve();
    expect(log).toHaveLength(0);
  });

  it('opens and emits the preamble before the triggering event, in order', async () => {
    const { transport, log, emitted } = fakeTransport();
    const mgr = createSessionManager({ transport, preamble });

    mgr.capture(ev('http.requested'));
    await mgr.flush();

    expect(log[0]?.kind).toBe('open');
    const types = emitted().map((e) => e.event_type);
    expect(types).toEqual([
      'session.started',
      'dependency.snapshot',
      'collector.report',
      'http.requested',
    ]);
    expect(mgr.state).toBe('open');
  });

  it('opens the session only once across many events', async () => {
    const { transport, log } = fakeTransport();
    const mgr = createSessionManager({ transport, preamble });
    mgr.capture(ev('http.requested'));
    mgr.capture(ev('process.exec'));
    await mgr.flush();
    mgr.capture(ev('http.completed'));
    await mgr.flush();
    expect(log.filter((r) => r.kind === 'open')).toHaveLength(1);
  });

  it('eager mode opens on construction without any event', async () => {
    const { transport, log } = fakeTransport();
    const mgr = createSessionManager({ transport, preamble, eager: true });
    await mgr.flush();
    expect(log.some((r) => r.kind === 'open')).toBe(true);
    expect(mgr.state).toBe('open');
  });

  it('complete() on an unused (idle) session does NOT create a session', async () => {
    const { transport, log } = fakeTransport();
    const mgr = createSessionManager({ transport, preamble });
    await mgr.complete();
    expect(log).toHaveLength(0);
    expect(mgr.state).toBe('closed');
  });

  it('complete() flushes, emits a closing report, then completes', async () => {
    const { transport, log, emitted } = fakeTransport();
    const mgr = createSessionManager({
      transport, preamble,
      closingReport: () => ({ event_type: 'collector.report', payload: { closing: true } }),
    });
    mgr.capture(ev('http.requested'));
    await mgr.complete();

    const kinds = log.map((r) => r.kind);
    expect(kinds[0]).toBe('open');
    expect(kinds[kinds.length - 1]).toBe('complete');
    const closing = emitted().filter((e) => e.event_type === 'collector.report' && e.payload['closing'] === true);
    expect(closing).toHaveLength(1);
    expect(mgr.state).toBe('closed');
  });

  it('complete() is idempotent', async () => {
    const { transport, log } = fakeTransport();
    const mgr = createSessionManager({ transport, preamble });
    mgr.capture(ev('http.requested'));
    await mgr.complete();
    await mgr.complete();
    expect(log.filter((r) => r.kind === 'complete')).toHaveLength(1);
  });

  it('abort() aborts an open session and is idempotent', async () => {
    const { transport, log } = fakeTransport();
    const mgr = createSessionManager({ transport, preamble });
    mgr.capture(ev('http.requested'));
    await mgr.flush();
    await mgr.abort();
    await mgr.abort();
    expect(log.filter((r) => r.kind === 'abort')).toHaveLength(1);
    expect(mgr.state).toBe('closed');
  });

  it('drops events captured after close without throwing', async () => {
    const { transport, emitted } = fakeTransport();
    const mgr = createSessionManager({ transport, preamble });
    mgr.capture(ev('http.requested'));
    await mgr.complete();
    expect(() => mgr.capture(ev('http.completed'))).not.toThrow();
    await mgr.flush();
    expect(emitted().some((e) => e.event_type === 'http.completed')).toBe(false);
  });

  it('never throws into the host when the transport open fails', async () => {
    const { transport } = fakeTransport({ open: vi.fn().mockRejectedValue(new Error('network down')) });
    const mgr = createSessionManager({ transport, preamble });
    expect(() => mgr.capture(ev('http.requested'))).not.toThrow();
    await expect(mgr.flush()).resolves.toBeUndefined();
    expect(mgr.state).toBe('closed');
  });

  it('never throws into the host when transport.emit fails', async () => {
    const { transport } = fakeTransport({ emit: vi.fn().mockRejectedValue(new Error('emit fail')) });
    const mgr = createSessionManager({ transport, preamble });
    mgr.capture(ev('http.requested'));
    await expect(mgr.flush()).resolves.toBeUndefined();
  });
});
