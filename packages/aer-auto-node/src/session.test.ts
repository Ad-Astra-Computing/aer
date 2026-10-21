import { describe, it, expect, vi } from 'vitest';
import { createSessionManager, AerRefusalError, type SessionTransport, type CollectorEvent } from './session.js';

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

describe('events the collector could not deliver', () => {
  it('are counted and handed to the closing report', async () => {
    let fail = true;
    const { transport } = fakeTransport({
      async emit(events) { if (fail && events.some((e) => e.event_type === 'lost')) throw new Error('timed out'); },
    });
    let seen: number | undefined;
    const mgr = createSessionManager({
      transport,
      preamble,
      closingReport: (s) => { seen = s.eventsDropped; return { event_type: 'collector.report', payload: { collector: 'x' } }; },
    });
    mgr.capture(ev('lost'));
    await mgr.flush();
    mgr.capture(ev('lost'));
    mgr.capture(ev('lost'));
    await mgr.flush();
    fail = false;
    mgr.capture(ev('kept'));
    await mgr.flush();
    await mgr.complete();
    expect(seen).toBe(3);
  });

  it('counts a preamble that could not be sent', async () => {
    const { transport } = fakeTransport({
      async emit(events) { if (events.some((e) => e.event_type === 'session.started')) throw new Error('down'); },
    });
    let seen: number | undefined;
    const mgr = createSessionManager({ transport, preamble, closingReport: (s) => { seen = s.eventsDropped; return null; } });
    mgr.capture(ev('x'));
    await mgr.complete();
    expect(seen).toBe(3);
  });

  it('are zero when every batch arrived', async () => {
    const { transport } = fakeTransport();
    let seen: number | undefined;
    const mgr = createSessionManager({ transport, preamble, closingReport: (s) => { seen = s.eventsDropped; return null; } });
    mgr.capture(ev('x'));
    await mgr.complete();
    expect(seen).toBe(0);
  });
});

describe('a refusal cooldown (usage cap / agent paused)', () => {
  function refusalTransport(recheckAfterSeconds: number) {
    const emit = vi.fn(async (events: CollectorEvent[]) => {
      if (events.some((e) => e.event_type === 'session.started')) return; // preamble always succeeds
      throw new AerRefusalError('usage_limit_reached', recheckAfterSeconds, 'AER tenant usage cap reached');
    });
    const { transport, log } = fakeTransport({ emit });
    return { transport, log, emit };
  }

  it('logs the refusal once and sets a cooldown', async () => {
    const { transport, emit } = refusalTransport(60);
    const errors: Array<{ err: unknown; ctx: string }> = [];
    const mgr = createSessionManager({ transport, preamble, onError: (err, ctx) => errors.push({ err, ctx }) });
    mgr.capture(ev('a'));
    await mgr.flush();
    expect(emit).toHaveBeenCalledTimes(2); // preamble + the refused batch
    const refusals = errors.filter((e) => e.err instanceof AerRefusalError);
    expect(refusals).toHaveLength(1);
  });

  it('drops further batches within the cooldown without calling emit again', async () => {
    const { transport, emit } = refusalTransport(60);
    const errors: unknown[] = [];
    let now = 1_000_000;
    const mgr = createSessionManager({ transport, preamble, onError: (err) => errors.push(err), now: () => now });
    mgr.capture(ev('a'));
    await mgr.flush();
    const callsAfterFirstRefusal = emit.mock.calls.length;

    mgr.capture(ev('b'));
    await mgr.flush();
    mgr.capture(ev('c'));
    await mgr.flush();

    expect(emit.mock.calls.length).toBe(callsAfterFirstRefusal); // no new emit() calls
    expect(errors.filter((e) => e instanceof AerRefusalError)).toHaveLength(1); // still just the one log line

    await mgr.complete();
  });

  it('resumes and calls emit again once the cooldown elapses', async () => {
    const { transport, emit } = refusalTransport(60);
    let now = 1_000_000;
    const mgr = createSessionManager({ transport, preamble, now: () => now });
    mgr.capture(ev('a'));
    await mgr.flush();
    const callsAfterFirstRefusal = emit.mock.calls.length;

    now += 61_000; // past the 60s recheck window
    mgr.capture(ev('b'));
    await mgr.flush();

    expect(emit.mock.calls.length).toBeGreaterThan(callsAfterFirstRefusal);
  });

  it('counts dropped events for the closing report during a cooldown', async () => {
    const { transport } = refusalTransport(60);
    let now = 1_000_000;
    let dropped: number | undefined;
    const mgr = createSessionManager({
      transport, preamble, now: () => now,
      closingReport: (s) => { dropped = s.eventsDropped; return null; },
    });
    mgr.capture(ev('a'));
    await mgr.flush();
    mgr.capture(ev('b'));
    await mgr.flush();
    await mgr.complete();
    // 'a' dropped by the refusal itself; 'b' dropped during the cooldown;
    // the closing report attempt (closingReport returns null, so nothing more
    // is emitted) does not add further drops.
    expect(dropped).toBeGreaterThanOrEqual(2);
  });

  it('a non-refusal error is unaffected: no cooldown, every batch attempted', async () => {
    const emit = vi.fn(async (events: CollectorEvent[]) => {
      if (events.some((e) => e.event_type === 'session.started')) return;
      throw new Error('plain failure');
    });
    const { transport } = fakeTransport({ emit });
    const mgr = createSessionManager({ transport, preamble });
    mgr.capture(ev('a'));
    await mgr.flush();
    const afterFirst = emit.mock.calls.length;
    mgr.capture(ev('b'));
    await mgr.flush();
    expect(emit.mock.calls.length).toBeGreaterThan(afterFirst);
  });
});
