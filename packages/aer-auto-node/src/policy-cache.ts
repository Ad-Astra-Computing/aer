// The usage policy, fetched once per agent per process and kept. Only the
// first fetch can hold a caller up, and only until a fixed deadline; the
// cache holds no timer, so it never keeps a process alive.

import type { UsagePolicy } from './policy.js';

export type PolicyPeek =
  /** An answer. `unavailable` means it is past its TTL and the last refresh failed. */
  | { known: true; policy: UsagePolicy | null; unavailable?: true }
  /** Not known yet. `waitUntil` is present only while a bounded wait is still allowed. */
  | { known: false; waitUntil?: number; pending?: Promise<void> };

export interface PolicyCache {
  /** Start fetching `agentId`'s policy unless it is known or already being fetched. */
  prefetch(agentId: string): void;
  /** What is known now. Starts a fetch for an unknown agent and a refresh for a stale one. */
  peek(agentId: string): PolicyPeek;
  /** Call `fn` once with the answer when the current fetch settles, or now if one is known or the fetch failed. */
  onSettled(agentId: string, fn: (policy: UsagePolicy | null) => void): void;
  /** Resolves when no fetch for `agentId` is in flight. Never rejects. */
  settled(agentId: string): Promise<void>;
}

export interface PolicyCacheOptions {
  /** Resolves with the policy, or null for "this agent has no policy". Throws or rejects when it could not find out. */
  fetcher: (agentId: string) => Promise<UsagePolicy | null> | UsagePolicy | null;
  /** How long an answer is fresh. Default 5 minutes. */
  ttlMs?: number;
  /** How long after a failed fetch before another is tried. Default 30 s. */
  retryMs?: number;
  /** How long after a first fetch starts a caller may still wait for it. Default 3 s. */
  waitMs?: number;
  now?: () => number;
}

export const POLICY_TTL_MS = 5 * 60_000;
export const POLICY_RETRY_MS = 30_000;
export const POLICY_WAIT_MS = 3_000;

interface Entry {
  known: boolean;
  policy: UsagePolicy | null;
  fetchedAt: number;
  /** When the last fetch failed; undefined once one succeeds. */
  failedAt?: number;
  attempts: number;
  inflight?: Promise<void>;
  startedAt: number;
  listeners: Array<(policy: UsagePolicy | null) => void>;
}

export function createPolicyCache(opts: PolicyCacheOptions): PolicyCache {
  const ttl = opts.ttlMs ?? POLICY_TTL_MS;
  const retry = opts.retryMs ?? POLICY_RETRY_MS;
  const waitMs = opts.waitMs ?? POLICY_WAIT_MS;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, Entry>();

  const entryFor = (agentId: string): Entry => {
    let e = entries.get(agentId);
    if (!e) {
      e = { known: false, policy: null, fetchedAt: 0, startedAt: 0, attempts: 0, listeners: [] };
      entries.set(agentId, e);
    }
    return e;
  };

  const retryDue = (e: Entry): boolean => e.failedAt === undefined || now() - e.failedAt >= retry;

  const start = (agentId: string, e: Entry): void => {
    if (e.inflight || !retryDue(e)) return;
    e.startedAt = now();
    e.attempts += 1;
    let result: Promise<UsagePolicy | null>;
    try {
      result = Promise.resolve(opts.fetcher(agentId));
    } catch (err) {
      result = Promise.reject(err);
    }
    e.inflight = result.then(
      (policy) => {
        e.known = true;
        e.policy = policy ?? null;
        e.fetchedAt = now();
        delete e.failedAt;
      },
      () => {
        // Not an answer: keep whatever was known, and try again later.
        e.failedAt = now();
      },
    ).then(() => {
      delete e.inflight;
      const listeners = e.listeners.splice(0);
      for (const fn of listeners) { try { fn(e.known ? e.policy : null); } catch { /* a listener never breaks the cache */ } }
    });
  };

  return {
    prefetch(agentId) {
      const e = entryFor(agentId);
      if (!e.known) start(agentId, e);
    },
    peek(agentId) {
      const e = entryFor(agentId);
      if (e.known) {
        const stale = now() - e.fetchedAt >= ttl;
        if (stale) start(agentId, e);
        return stale && e.failedAt !== undefined
          ? { known: true, policy: e.policy, unavailable: true }
          : { known: true, policy: e.policy };
      }
      start(agentId, e);
      // Only the first attempt for an agent may hold a caller up.
      const until = e.startedAt + waitMs;
      if (e.inflight && e.attempts === 1 && now() < until) return { known: false, waitUntil: until, pending: e.inflight };
      return { known: false };
    },
    onSettled(agentId, fn) {
      const e = entryFor(agentId);
      if (!e.known) start(agentId, e);
      if (e.known || !e.inflight) { try { fn(e.policy); } catch { /* ignore */ } return; }
      e.listeners.push(fn);
    },
    settled(agentId) {
      return entries.get(agentId)?.inflight ?? Promise.resolve();
    },
  };
}
