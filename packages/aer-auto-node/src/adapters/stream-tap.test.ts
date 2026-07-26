import { describe, it, expect } from 'vitest';
import { tapAsyncIterable, isAsyncIterable, usageObserved, type StreamAccumulator } from './stream-tap.js';

// A controllable async-iterable that counts how many times its iterator is
// advanced, so tests can prove the tap never pulls ahead of the host.
function makeStream(chunks: unknown[]): { stream: AsyncIterable<unknown> & { pulls: number }; } {
  const obj = {
    pulls: 0,
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      let i = 0;
      return {
        next: async (): Promise<IteratorResult<unknown>> => {
          obj.pulls++;
          if (i < chunks.length) return { done: false, value: chunks[i++] };
          return { done: true, value: undefined };
        },
      };
    },
  };
  return { stream: obj as AsyncIterable<unknown> & { pulls: number } };
}

const countFold = (chunk: unknown, acc: StreamAccumulator): void => {
  const c = chunk as { tool?: string; out?: number };
  if (typeof c.out === 'number') acc.output_tokens = c.out;
  if (typeof c.tool === 'string') acc.tool_names.push(c.tool);
};

describe('tapAsyncIterable', () => {
  it('does not advance the iterator until the host iterates', () => {
    const { stream } = makeStream([{ out: 1 }]);
    let ended = false;
    const ok = tapAsyncIterable(stream, countFold, () => { ended = true; });
    expect(ok).toBe(true);
    expect(stream.pulls).toBe(0); // tapping alone pulls nothing
    expect(ended).toBe(false);
  });

  it('passes every chunk through unchanged and folds metadata, firing onEnd once', async () => {
    const { stream } = makeStream([{ out: 5, tool: 'search' }, { out: 9 }]);
    let endAcc: StreamAccumulator | null = null;
    let ends = 0;
    tapAsyncIterable(stream, countFold, (acc) => { endAcc = acc; ends++; });

    const seen: unknown[] = [];
    for await (const c of stream) seen.push(c);

    expect(seen).toEqual([{ out: 5, tool: 'search' }, { out: 9 }]);
    expect(ends).toBe(1);
    expect(endAcc).toMatchObject({ output_tokens: 9, tool_names: ['search'], chunks: 2 });
  });

  it('fires onEnd (not errored) when the host breaks early via return()', async () => {
    const { stream } = makeStream([{ out: 1 }, { out: 2 }, { out: 3 }]);
    let errored: boolean | undefined;
    let ends = 0;
    tapAsyncIterable(stream, countFold, (_acc, e) => { errored = e; ends++; });

    for await (const _c of stream) break; // eslint-disable-line no-unused-vars

    expect(ends).toBe(1);
    expect(errored).toBe(false);
  });

  it('fires onEnd with errored=true when the iterator throws', async () => {
    const obj = {
      [Symbol.asyncIterator](): AsyncIterator<unknown> {
        return { next: async () => { throw new Error('stream boom'); } };
      },
    };
    let errored: boolean | undefined;
    let acc: StreamAccumulator | null = { tool_names: [], chunks: 0 };
    tapAsyncIterable(obj, countFold, (a, e) => { acc = a; errored = e; });

    await expect((async () => { for await (const _c of obj) { /* noop */ } })()).rejects.toThrow('stream boom');
    expect(errored).toBe(true);
    expect(acc).toBeNull();
  });

  it('preserves object identity and prototype (only the iterator method is shadowed)', () => {
    class FakeStream {
      tee(): string { return 'teed'; }
      async *[Symbol.asyncIterator](): AsyncGenerator<number> { yield 1; }
    }
    const s = new FakeStream();
    const ok = tapAsyncIterable(s, countFold, () => undefined);
    expect(ok).toBe(true);
    expect(s).toBeInstanceOf(FakeStream); // prototype intact
    expect(s.tee()).toBe('teed'); // other methods intact
  });

  it('returns false when the iterator slot is non-configurable (frozen)', () => {
    const frozen = Object.freeze({
      async *[Symbol.asyncIterator](): AsyncGenerator<number> { yield 1; },
    });
    const ok = tapAsyncIterable(frozen, countFold, () => undefined);
    expect(ok).toBe(false);
  });

  it('returns false for a non-async-iterable', () => {
    expect(tapAsyncIterable({}, countFold, () => undefined)).toBe(false);
  });
});

describe('isAsyncIterable / usageObserved', () => {
  it('detects async iterables', () => {
    expect(isAsyncIterable({ [Symbol.asyncIterator]: () => ({}) })).toBe(true);
    expect(isAsyncIterable({})).toBe(false);
    expect(isAsyncIterable(null)).toBe(false);
  });

  it('usageObserved is true only when TOKEN usage was captured (not stop_reason/tools)', () => {
    expect(usageObserved(null)).toBe(false);
    expect(usageObserved({ tool_names: [], chunks: 3 })).toBe(false);
    expect(usageObserved({ tool_names: [], chunks: 1, output_tokens: 2 })).toBe(true);
    expect(usageObserved({ tool_names: [], chunks: 1, input_tokens: 5 })).toBe(true);
    // stop_reason / tool names alone do NOT count as usage observed
    expect(usageObserved({ tool_names: ['x'], chunks: 1 })).toBe(false);
    expect(usageObserved({ tool_names: [], chunks: 1, stop_reason: 'stop' })).toBe(false);
  });
});
