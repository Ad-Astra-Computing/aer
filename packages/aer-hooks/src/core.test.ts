import { describe, it, expect } from 'vitest';
import type { EventSink } from '@adastracomputing/aer-emit';
import { emitHookEvent } from './core.js';
import type { HookEvent } from './normalize.js';

interface Captured {
  eventType: string;
  payload: Record<string, unknown>;
}

function fakeSink(): { sink: EventSink; events: Captured[] } {
  const events: Captured[] = [];
  const sink: EventSink = {
    emit(eventType, payload) {
      events.push({ eventType, payload });
    },
    async close() {
      /* no-op */
    },
  };
  return { sink, events };
}

describe('emitHookEvent mapping', () => {
  it('tool_start -> tool.started with tool + arg_keys', () => {
    const { sink, events } = fakeSink();
    const e: HookEvent = { kind: 'tool_start', tool: 'Bash', argKeys: ['command'], sessionRef: 's1' };
    emitHookEvent(e, sink, { env: {} });
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('tool.started');
    expect(events[0]!.payload).toEqual({ tool: 'Bash', arg_keys: ['command'], session_ref: 's1' });
  });

  it('tool_end -> tool.completed with ok + is_error', () => {
    const { sink, events } = fakeSink();
    emitHookEvent({ kind: 'tool_end', tool: 'Edit', ok: true, isError: false }, sink, { env: {} });
    expect(events[0]!.eventType).toBe('tool.completed');
    expect(events[0]!.payload).toEqual({ tool: 'Edit', ok: true, is_error: false });
  });

  it('session_start/end and prompt map to collector.report markers (valid EventSchema types)', () => {
    const { sink, events } = fakeSink();
    emitHookEvent({ kind: 'session_start', sessionRef: 's' }, sink, { env: {} });
    emitHookEvent({ kind: 'session_end', sessionRef: 's' }, sink, { env: {} });
    emitHookEvent({ kind: 'prompt', sessionRef: 's' }, sink, { env: {} });
    // All three become collector.report so the API accepts them; the marker is
    // carried in `phase`. Lifecycle authority stays with session open/complete,
    // so we never emit synthetic session.started/ended.
    expect(events.map((e) => e.eventType)).toEqual([
      'collector.report',
      'collector.report',
      'collector.report',
    ]);
    expect(events[0]!.payload).toEqual({ collector: 'aer-hooks', phase: 'session_start', session_ref: 's' });
    expect(events[1]!.payload).toEqual({ collector: 'aer-hooks', phase: 'session_end', session_ref: 's' });
    expect(events[2]!.payload).toEqual({ collector: 'aer-hooks', phase: 'prompt', session_ref: 's' });
  });

  it('drops kind=other', () => {
    const { sink, events } = fakeSink();
    emitHookEvent({ kind: 'other' }, sink, { env: {} });
    expect(events).toHaveLength(0);
  });

  it('does not include arg_values by default', () => {
    const { sink, events } = fakeSink();
    emitHookEvent({ kind: 'tool_start', tool: 'Bash', argKeys: ['command'] }, sink, {
      env: {},
      raw: { tool_input: { command: 'rm -rf /' } },
    });
    expect(events[0]!.payload['arg_values']).toBeUndefined();
    expect(JSON.stringify(events[0]!.payload)).not.toContain('rm -rf');
  });

  it('includes arg_values only when AER_HOOK_RECORD_ARGS=1', () => {
    const { sink, events } = fakeSink();
    emitHookEvent({ kind: 'tool_start', tool: 'Bash', argKeys: ['command'] }, sink, {
      env: { AER_HOOK_RECORD_ARGS: '1' },
      raw: { tool_input: { command: 'ls' } },
    });
    expect(events[0]!.payload['arg_values']).toEqual({ command: 'ls' });
  });

  it('never throws when the sink emit throws', () => {
    const throwingSink: EventSink = {
      emit() {
        throw new Error('sink down');
      },
      async close() {},
    };
    expect(() =>
      emitHookEvent({ kind: 'tool_start', tool: 'x' }, throwingSink, { env: {} }),
    ).not.toThrow();
  });

  it('never throws on a garbage event object', () => {
    const { sink } = fakeSink();
    // deliberately bypass the type to feed garbage
    expect(() => emitHookEvent({ kind: 'nope' } as never, sink, { env: {} })).not.toThrow();
    expect(() => emitHookEvent(null as never, sink, { env: {} })).not.toThrow();
  });
});
