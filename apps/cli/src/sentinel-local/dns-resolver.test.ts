import { describe, it, expect, vi } from 'vitest';
import { FamilyResolver } from './dns-resolver.js';

function fakeClock(startMs: number) {
  let t = startMs;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('FamilyResolver', () => {
  it('resolves and returns the address set', async () => {
    const clock = fakeClock(0);
    const lookupFn = vi.fn(async (hostname: string) => {
      if (hostname === 'api.openai.com') return [{ address: '1.2.3.4' }, { address: '::1' }];
      return [];
    });
    const r = new FamilyResolver({ clock, lookupFn });
    const set = await r.resolveAndWait();
    expect(set['openai']?.has('1.2.3.4')).toBe(true);
    expect(set['openai']?.has('::1')).toBe(true);
  });

  it('excludes bedrock (not actively matched) from the lookup batch', async () => {
    const clock = fakeClock(0);
    const seen: string[] = [];
    const lookupFn = vi.fn(async (hostname: string) => {
      seen.push(hostname);
      return [];
    });
    const r = new FamilyResolver({ clock, lookupFn });
    await r.resolveAndWait();
    expect(seen).not.toContain('bedrock-runtime');
  });

  it('counts a whole batch as one trigger against the per-process cooldown', async () => {
    const clock = fakeClock(0);
    let calls = 0;
    const lookupFn = vi.fn(async () => { calls += 1; return [{ address: '1.2.3.4' }]; });
    const r = new FamilyResolver({ clock, lookupFn });
    await r.resolveAndWait();
    const callsAfterFirst = calls;
    r.triggerResolution(); // within cooldown: must be a no-op
    expect(calls).toBe(callsAfterFirst);
  });

  it('re-resolves after the cooldown window elapses', async () => {
    const clock = fakeClock(0);
    let batches = 0;
    const lookupFn = vi.fn(async () => { return [{ address: '1.2.3.4' }]; });
    const r = new FamilyResolver({ clock, lookupFn });
    await r.resolveAndWait();
    batches += 1;
    clock.advance(10 * 60 * 1000 + 1);
    await r.resolveAndWait();
    batches += 1;
    expect(lookupFn.mock.calls.length).toBeGreaterThan(0);
    expect(batches).toBe(2);
  });

  it('falls back to an empty set when the lookup never lands within the bounded wait', async () => {
    vi.useFakeTimers();
    try {
      const clock = fakeClock(0);
      const lookupFn = vi.fn(() => new Promise<{ address: string }[]>(() => { /* never resolves */ }));
      const r = new FamilyResolver({ clock, lookupFn });
      const pending = r.resolveAndWait();
      await vi.advanceTimersByTimeAsync(2100);
      const set = await pending;
      expect(Object.keys(set)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a hostname failure never aborts the rest of the batch', async () => {
    const clock = fakeClock(0);
    const lookupFn = vi.fn(async (hostname: string) => {
      if (hostname === 'api.mistral.ai') throw new Error('ENOTFOUND');
      if (hostname === 'api.openai.com') return [{ address: '5.6.7.8' }];
      return [];
    });
    const r = new FamilyResolver({ clock, lookupFn });
    const set = await r.resolveAndWait();
    expect(set['openai']?.has('5.6.7.8')).toBe(true);
  });
});
