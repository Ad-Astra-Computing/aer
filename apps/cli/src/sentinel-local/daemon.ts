// The daemon's run loop: poll every 15s (default), push only when there is
// new data, batched, at most once per 60s, with exponential backoff on
// 429/503 and a bounded, disk-backed outbox replayed on restart.

import { appendToOutbox, readOutbox, removeFromOutboxFront, type Outbox } from './state.js';
import { runPollTick, ConnectionSeenSet, type NormalizedCandidate } from './poll-tick.js';
import { FamilyResolver } from './dns-resolver.js';
import type { SentinelLocalApiClient } from './http-client.js';

export const DEFAULT_POLL_INTERVAL_MS = 15_000;
export const DEFAULT_PUSH_INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 10 * 60_000;

export interface DaemonDeps {
  perInstallKey: Buffer;
  sensorSourceId: string;
  pushToken: string;
  apiClient: SentinelLocalApiClient;
  enumerate: () => Promise<NormalizedCandidate[]>;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  pollIntervalMs?: number;
  pushIntervalMs?: number;
}

export interface DaemonState {
  resolver: FamilyResolver;
  seenSet: ConnectionSeenSet;
  tick: number;
  lastPushAt: number;
  backoffMs: number;
}

export function initialDaemonState(): DaemonState {
  // lastPushAt starts at -Infinity (never pushed yet), not 0: with a `now()`
  // that itself starts near epoch 0 in a test, `0 - 0 >= interval` would be
  // false and silently swallow the very first push.
  return { resolver: new FamilyResolver(), seenSet: new ConnectionSeenSet(), tick: 0, lastPushAt: -Infinity, backoffMs: 0 };
}

/** One poll tick: enumerates candidates, runs the classifier/evidence
 * pipeline, appends any new rows to the disk-backed outbox, and pushes the
 * outbox's contents if the push cadence/backoff allows it this tick. Returns
 * the updated state (callers persist it between calls themselves; only
 * `tick`/`lastPushAt`/`backoffMs` matter across a real restart, and per the
 * design the in-memory seen-set deliberately does not persist). */
export async function runDaemonTick(state: DaemonState, deps: DaemonDeps): Promise<DaemonState> {
  const now = deps.now ?? (() => new Date());
  const candidates = await deps.enumerate();
  const newRows = await runPollTick(candidates, {
    perInstallKey: deps.perInstallKey,
    resolver: state.resolver,
    seenSet: state.seenSet,
    tick: state.tick,
    now,
  });

  let outbox: Outbox = readOutbox(deps.env);
  if (newRows.length > 0) outbox = appendToOutbox(newRows, deps.env);

  const nowMs = now().getTime();
  const pushIntervalMs = deps.pushIntervalMs ?? DEFAULT_PUSH_INTERVAL_MS;
  const cadenceElapsed = nowMs - state.lastPushAt >= pushIntervalMs;
  const backoffElapsed = nowMs - state.lastPushAt >= state.backoffMs;
  const hasData = outbox.rows.length > 0;

  let { lastPushAt, backoffMs } = state;
  if (hasData && cadenceElapsed && backoffElapsed) {
    const result = await deps.apiClient.push(deps.sensorSourceId, deps.pushToken, outbox.rows);
    lastPushAt = nowMs;
    if (result.ok) {
      removeFromOutboxFront(outbox.rows.length, deps.env);
      backoffMs = 0;
    } else if (result.retryable) {
      backoffMs = backoffMs === 0 ? 10_000 : Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
    // A non-retryable failure (4xx other than what retry helps with) is left
    // in the outbox for the next tick too - the server-side TODO notwithstanding,
    // we never silently drop data except via the outbox's own cap.
  }

  return { ...state, tick: state.tick + 1, lastPushAt, backoffMs };
}

// The real, forever-running loop the generated systemd unit/launchd plist
// invokes (`sentinel-local run-daemon`), ticking every `pollIntervalMs` until
// killed. Not unit-tested directly (it never returns); `runDaemonTick` above
// carries the tested logic for one tick.
export async function runDaemonForever(
  deps: Omit<DaemonDeps, 'now'> & { signal?: AbortSignal },
): Promise<void> {
  let state = initialDaemonState();
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  while (!deps.signal?.aborted) {
    try {
      state = await runDaemonTick(state, deps);
    } catch {
      // A single bad tick (a transient /proc read failure, a DNS hiccup)
      // must never kill the daemon; it simply tries again next tick.
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
