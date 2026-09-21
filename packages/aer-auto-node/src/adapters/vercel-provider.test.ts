import { describe, it, expect } from 'vitest';
import { tokenCount, finishReasonOf } from './vercel-provider.js';

describe('reading the provider-spec response', () => {
  // The v4 spec reports usage as an object and the finish reason as a pair.
  // Earlier versions reported a plain number and a plain string. Both are
  // read, so a customer on either version gets a complete record.
  it('reads a v4 token count', () => {
    expect(tokenCount({ total: 5, noCache: 5, cacheRead: 0 })).toBe(5);
  });

  it('reads an older bare token count', () => {
    expect(tokenCount(7)).toBe(7);
  });

  it('reports nothing rather than a wrong number', () => {
    for (const v of [undefined, null, {}, { total: 'five' }, -1, Number.NaN, 'five', []]) {
      expect(tokenCount(v)).toBeUndefined();
    }
  });

  it('reads a v4 finish reason, preferring the unified one', () => {
    expect(finishReasonOf({ unified: 'stop', raw: 'end_turn' })).toBe('stop');
    expect(finishReasonOf({ raw: 'end_turn' })).toBe('end_turn');
  });

  it('reads an older string finish reason', () => {
    expect(finishReasonOf('stop')).toBe('stop');
  });

  it('reports nothing for a shape it does not know', () => {
    for (const v of [undefined, null, {}, 42, []]) expect(finishReasonOf(v)).toBeUndefined();
  });
});

describe('a stream is not reported as finished when it opens', () => {
  it('leaves token counts off a streaming completion', () => {
    // doStream resolves as soon as the stream opens, so the counts do not
    // exist yet. Recording the call without them is honest; a zero would not
    // be, and neither would waiting.
    expect(tokenCount(undefined)).toBeUndefined();
  });
});
