// A model call followed immediately by session completion must still record
// that it finished.

// Adopting a foreign thenable costs extra microtask ticks, so the caller's
// await runs first and can flush before llm.completed is emitted.

import { describe, it, expect } from 'vitest';
import { wrapCreate, pendingObservations } from './llm-core.js';
import type { CollectorEvent } from '../session.js';

/** A thenable like the vendor SDKs return: adoption takes several ticks. */
function slowThenable<T>(value: T, ticks = 4): PromiseLike<T> {
  return {
    then(onFulfilled) {
      let p = Promise.resolve();
      for (let i = 0; i < ticks; i++) p = p.then(() => undefined);
      void p.then(() => onFulfilled?.(value));
      return undefined as never;
    },
  };
}

describe('a completion emitted after the caller moved on', () => {
  it('is still recorded when the session completes immediately', async () => {
    const events: CollectorEvent[] = [];
    const capture = (e: CollectorEvent): void => { events.push(e); };

    const wrapped = wrapCreate(
      () => slowThenable({ model: 'claude-sonnet-4-5', usage: { input_tokens: 7, output_tokens: 2 } }),
      {
        provider: 'anthropic',
        extractRequest: () => ({ model: 'claude-sonnet-4-5' }),
        extractResponse: (r: unknown) => {
          const res = r as { model: string; usage: { input_tokens: number; output_tokens: number } };
          return { model: res.model, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
        },
      } as never,
      capture,
    );

    await (wrapped as (...a: unknown[]) => PromiseLike<unknown>)({});
    // What the collector must do before it flushes: let the observations it
    // already started finish.
    await pendingObservations();

    const types = events.map((e) => e.event_type);
    expect(types).toContain('llm.requested');
    expect(types, 'the completion was lost to the flush').toContain('llm.completed');
  });

  it('resolves immediately when nothing is in flight', async () => {
    await expect(pendingObservations()).resolves.toBeUndefined();
  });
});
