import { describe, it, expect, vi } from 'vitest';
import { createPolicyCache } from './policy-cache.js';
import type { UsagePolicy } from './policy.js';

const block: UsagePolicy = { policy_id: 'p1', version: 1, mode: 'block', on_unavailable: 'fail_open', llm: { denied_models: ['x-*'] } };
const report: UsagePolicy = { ...block, version: 2, mode: 'report' };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('the per-process usage-policy cache', () => {
  it('fetches once per agent, however many sessions ask', async () => {
    const fetcher = vi.fn(async () => block);
    const cache = createPolicyCache({ fetcher });
    cache.prefetch('a1');
    cache.prefetch('a1');
    await cache.settled('a1');
    expect(cache.peek('a1')).toEqual({ known: true, policy: block });
    expect(cache.peek('a1')).toEqual({ known: true, policy: block });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('remembers that an agent has no policy, so nothing waits for it again', async () => {
    const fetcher = vi.fn(async () => null);
    const cache = createPolicyCache({ fetcher });
    cache.prefetch('a1');
    await cache.settled('a1');
    expect(cache.peek('a1')).toEqual({ known: true, policy: null });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps each agent separate', async () => {
    const cache = createPolicyCache({ fetcher: async (agent) => (agent === 'a1' ? block : report) });
    cache.prefetch('a1');
    cache.prefetch('a2');
    await Promise.all([cache.settled('a1'), cache.settled('a2')]);
    expect(cache.peek('a1')).toEqual({ known: true, policy: block });
    expect(cache.peek('a2')).toEqual({ known: true, policy: report });
  });

  it('offers a wait only while the first fetch is in flight, bounded from when it started', async () => {
    let now = 1_000;
    const d = deferred<UsagePolicy | null>();
    const cache = createPolicyCache({ fetcher: () => d.promise, now: () => now, waitMs: 3_000 });
    cache.prefetch('a1');
    now = 2_000;
    const early = cache.peek('a1');
    expect(early.known).toBe(false);
    expect(early.known === false && early.waitUntil).toBe(4_000);
    now = 4_000;
    // Past the bound: an unanswered fetch no longer holds anyone up.
    const late = cache.peek('a1');
    expect(late).toEqual({ known: false });
    d.resolve(block);
    await cache.settled('a1');
    expect(cache.peek('a1')).toEqual({ known: true, policy: block });
  });

  it('peeking an agent it has never fetched starts the fetch', async () => {
    const fetcher = vi.fn(async () => block);
    const cache = createPolicyCache({ fetcher });
    const first = cache.peek('a9');
    expect(first.known).toBe(false);
    await cache.settled('a9');
    expect(cache.peek('a9')).toEqual({ known: true, policy: block });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('serves a stale policy without waiting and refreshes it in the background', async () => {
    let now = 0;
    let answer: UsagePolicy = block;
    const fetcher = vi.fn(async () => answer);
    const cache = createPolicyCache({ fetcher, now: () => now, ttlMs: 60_000 });
    cache.prefetch('a1');
    await cache.settled('a1');
    answer = report;
    now = 61_000;
    expect(cache.peek('a1')).toEqual({ known: true, policy: block });
    await cache.settled('a1');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cache.peek('a1')).toEqual({ known: true, policy: report });
  });

  it('never throws and never rejects when the fetcher does, and a failed first fetch stays unknown', async () => {
    const cache = createPolicyCache({ fetcher: () => { throw new Error('boom'); } });
    expect(() => cache.prefetch('a1')).not.toThrow();
    await expect(cache.settled('a1')).resolves.toBeUndefined();
    expect(cache.peek('a1')).toEqual({ known: false });
    const rejecting = createPolicyCache({ fetcher: async () => { throw new Error('boom'); } });
    rejecting.prefetch('a1');
    await expect(rejecting.settled('a1')).resolves.toBeUndefined();
    expect(rejecting.peek('a1')).toEqual({ known: false });
  });

  it('retries a failed first fetch after 30 s, and never offers a wait on a retry', async () => {
    let now = 0;
    let fail = true;
    const fetcher = vi.fn(async () => { if (fail) throw new Error('down'); return block; });
    const cache = createPolicyCache({ fetcher, now: () => now });
    cache.prefetch('a1');
    await cache.settled('a1');
    now = 29_000;
    expect(cache.peek('a1')).toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 31_000;
    fail = false;
    expect(cache.peek('a1')).toEqual({ known: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await cache.settled('a1');
    expect(cache.peek('a1')).toEqual({ known: true, policy: block });
  });

  it('keeps the last good policy when a refresh fails, and retries in 30 s', async () => {
    let now = 0;
    let fail = false;
    const fetcher = vi.fn(async () => { if (fail) throw new Error('down'); return block; });
    const cache = createPolicyCache({ fetcher, now: () => now, ttlMs: 60_000 });
    cache.prefetch('a1');
    await cache.settled('a1');
    fail = true;
    now = 61_000;
    expect(cache.peek('a1')).toEqual({ known: true, policy: block });
    await cache.settled('a1');
    // The refresh failed: still the last good policy, now marked unavailable.
    expect(cache.peek('a1')).toEqual({ known: true, policy: block, unavailable: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    now = 80_000;
    cache.peek('a1');
    expect(fetcher).toHaveBeenCalledTimes(2);
    now = 92_000;
    fail = false;
    cache.peek('a1');
    expect(fetcher).toHaveBeenCalledTimes(3);
    await cache.settled('a1');
    expect(cache.peek('a1')).toEqual({ known: true, policy: block });
  });

  it('caches "no policy" as an answer, unlike a failure', async () => {
    let now = 0;
    const fetcher = vi.fn(async () => null);
    const cache = createPolicyCache({ fetcher, now: () => now });
    cache.prefetch('a1');
    await cache.settled('a1');
    now = 60_000;
    expect(cache.peek('a1')).toEqual({ known: true, policy: null });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('tells a subscriber when the policy lands', async () => {
    const d = deferred<UsagePolicy | null>();
    const cache = createPolicyCache({ fetcher: () => d.promise });
    cache.prefetch('a1');
    const seen: Array<UsagePolicy | null> = [];
    cache.onSettled('a1', (p) => seen.push(p));
    d.resolve(block);
    await cache.settled('a1');
    expect(seen).toEqual([block]);
  });
});
