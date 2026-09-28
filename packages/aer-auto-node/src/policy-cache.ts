// The usage policy, fetched once per agent per process and kept. Only the
// first fetch can hold a caller up, and only until a fixed deadline; the
// cache holds no timer, so it never keeps a process alive.

import type { UsagePolicy } from './policy.js';

export type PolicyPeek =
  | { known: true; policy: UsagePolicy | null }
  /** Not known yet. `waitUntil` is present only while a bounded wait is still allowed. */
  | { known: false; waitUntil?: number; pending?: Promise<void> };

export interface PolicyCache {
  /** Start fetching `agentId`'s policy unless it is known or already being fetched. */
  prefetch(agentId: string): void;
  /** What is known now. Starts a fetch for an unknown agent and a refresh for a stale one. */
  peek(agentId: string): PolicyPeek;
  /** Call `fn` once with the policy when the current fetch settles, or now if it is known. */
  onSettled(agentId: string, fn: (policy: UsagePolicy | null) => void): void;
  /** Resolves when no fetch for `agentId` is in flight. Never rejects. */
  settled(agentId: string): Promise<void>;
}

export interface PolicyCacheOptions {
  fetcher: (agentId: string) => Promise<UsagePolicy | null> | UsagePolicy | null;
  /** How long a fetched answer is fresh. Default 5 minutes. */
  ttlMs?: number;
  /** How long after a first fetch starts a caller may still wait for it. Default 3 s. */
  waitMs?: number;
  now?: () => number;
}

export const POLICY_TTL_MS = 5 * 60_000;
export const POLICY_WAIT_MS = 3_000;

interface Entry {
  known: boolean;
  policy: UsagePolicy | null;
  fetchedAt: number;
  inflight?: Promise<void>;
  startedAt: number;
  listeners: Array<(policy: UsagePolicy | null) => void>;
}

export function createPolicyCache(opts: PolicyCacheOptions): PolicyCache {
  const ttl = opts.ttlMs ?? POLICY_TTL_MS;
  const waitMs = opts.waitMs ?? POLICY_WAIT_MS;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, Entry>();

  const entryFor = (agentId: string): Entry => {
    let e = entries.get(agentId);
    if (!e) {
      e = { known: false, policy: null, fetchedAt: 0, startedAt: 0, listeners: [] };
      entries.set(agentId, e);
    }
    return e;
  };

  const start = (agentId: string, e: Entry): void => {
    if (e.inflight) return;
    e.startedAt = now();
    let result: Promise<UsagePolicy | null>;
    try {
      result = Promise.resolve(opts.fetcher(agentId));
    } catch {
      result = Promise.resolve(null);
    }
    e.inflight = result
      .then((p) => p ?? null, () => null)
      .then((policy) => {
        e.known = true;
        e.policy = policy;
        e.fetchedAt = now();
        delete e.inflight;
        const listeners = e.listeners.splice(0);
        for (const fn of listeners) { try { fn(policy); } catch { /* a listener never breaks the cache */ } }
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
        if (!e.inflight && now() - e.fetchedAt >= ttl) start(agentId, e);
        return { known: true, policy: e.policy };
      }
      start(agentId, e);
      const until = e.startedAt + waitMs;
      if (e.inflight && now() < until) return { known: false, waitUntil: until, pending: e.inflight };
      return { known: false };
    },
    onSettled(agentId, fn) {
      const e = entryFor(agentId);
      if (e.known) { try { fn(e.policy); } catch { /* ignore */ } return; }
      e.listeners.push(fn);
      start(agentId, e);
    },
    settled(agentId) {
      return entries.get(agentId)?.inflight ?? Promise.resolve();
    },
  };
}
