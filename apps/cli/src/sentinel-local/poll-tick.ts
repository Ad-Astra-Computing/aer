// One poll tick's worth of orchestration: takes already-classified candidate
// processes (platform backends produce these), figures out which
// connections are newly first-seen, classifies their destination, checks
// instrumentation, and emits the wire rows for this tick (design doc §2.1,
// §5.4). Platform-agnostic: linux-backend.ts and macos-backend.ts both feed
// into this through a shared, normalized shape.

import { classifyDestination } from './destination.js';
import { checkInstrumentation } from './instrumentation.js';
import { computeObservationId } from './observation-id.js';
import { normalizeIp } from './provider-ranges.js';
import type { FamilyResolver } from './dns-resolver.js';
import type { ObservationRow, Tool } from './types.js';

export interface NormalizedCandidate {
  tool: Tool;
  /** The process's own working directory, when the platform backend could
   * determine it this tick (used for the project-scope instrumentation
   * check only - never sent). */
  cwd?: string | undefined;
  sockets: Array<{ localAddress: string; localPort: number; remoteAddress: string; remotePort: number }>;
}

/** In-memory only, per design doc: does NOT persist across a daemon restart
 * (a restart that loses it can at worst re-send observation_ids for still-
 * open connections, which the server's insert treats as an idempotent
 * no-op). */
export class ConnectionSeenSet {
  private readonly firstSeenTick = new Map<string, number>();

  private key(local: string, localPort: number, remote: string, remotePort: number): string {
    return `${local}:${localPort}->${remote}:${remotePort}`;
  }

  /** Returns the tick this connection was first seen, recording `tick` as
   * first-seen if this is new. */
  recordAndGetFirstSeen(local: string, localPort: number, remote: string, remotePort: number, tick: number): {
    firstSeenTick: number;
    isNew: boolean;
  } {
    const k = this.key(local, localPort, remote, remotePort);
    const existing = this.firstSeenTick.get(k);
    if (existing !== undefined) return { firstSeenTick: existing, isNew: false };
    this.firstSeenTick.set(k, tick);
    return { firstSeenTick: tick, isNew: true };
  }
}

export interface PollTickDeps {
  perInstallKey: Buffer;
  resolver: FamilyResolver;
  seenSet: ConnectionSeenSet;
  tick: number;
  now: () => Date;
}

/** Runs one poll tick over the already-classified candidates and returns the
 * wire rows for connections first seen THIS tick (design doc: one
 * observation = one distinct connection first seen, never one row per poll
 * tick). A row is produced only when destination evidence is real, or the
 * process is a known_ai_cli on port 443 with no address match at all. */
export async function runPollTick(candidates: NormalizedCandidate[], deps: PollTickDeps): Promise<ObservationRow[]> {
  const rows: ObservationRow[] = [];
  let triggeredResolutionThisTick = false;

  // Dedupe instrumentation checks: at most one status() call set per
  // (tool, cwd) pair per tick, however many new connections that tool has.
  const instrumentationCache = new Map<string, Promise<ObservationRow['instrumentation']>>();
  const instrumentationFor = (tool: Tool, cwd: string | undefined): Promise<ObservationRow['instrumentation']> => {
    const key = `${tool}\0${cwd ?? ''}`;
    let cached = instrumentationCache.get(key);
    if (!cached) {
      cached = checkInstrumentation(tool, { processCwd: cwd });
      instrumentationCache.set(key, cached);
    }
    return cached;
  };

  for (const candidate of candidates) {
    for (const socket of candidate.sockets) {
      const { firstSeenTick, isNew } = deps.seenSet.recordAndGetFirstSeen(
        socket.localAddress,
        socket.localPort,
        socket.remoteAddress,
        socket.remotePort,
        deps.tick,
      );
      if (!isNew) continue; // same live connection already reported on an earlier tick

      // B2: this socket is OFFERED the once-per-tick trigger budget, but
      // the budget is only actually consumed if classifyDestination tells
      // us it really invoked the resolver (an owned-range match or a
      // non-443 connection never touches DNS at all, so offering it to
      // them must not burn the trigger for a later socket that needs it).
      const triggeredThisConnection = !triggeredResolutionThisTick;
      const destination = await classifyDestination(socket.remoteAddress, socket.remotePort, deps.resolver, {
        triggeredThisConnection,
      });
      if (destination.triggeredResolution) triggeredResolutionThisTick = true;

      const eligible = destination.evidence !== 'none' || socket.remotePort === 443;
      if (!eligible) continue; // §2.1: no real evidence and not even an unmatched port-443 case -> no row

      const instrumentation = await instrumentationFor(candidate.tool, candidate.cwd);

      const observationId = computeObservationId(
        deps.perInstallKey,
        { localAddress: socket.localAddress, localPort: socket.localPort, remoteAddress: socket.remoteAddress, remotePort: socket.remotePort },
        firstSeenTick,
      );

      const row: ObservationRow = {
        observation_id: observationId,
        observed_at: deps.now().toISOString(),
        destination_evidence: destination.evidence,
        destination_family: destination.family,
        tool: candidate.tool,
        instrumentation,
      };
      if (destination.evidence !== 'none') {
        // Use the normalized form on the wire too (never the raw
        // v4-mapped-in-v6 form a Linux socket reports), matching what the
        // classifier itself matched against.
        row.destination_ip = normalizeIp(socket.remoteAddress);
        row.destination_port = socket.remotePort;
      }
      rows.push(row);
    }
  }

  return rows;
}
