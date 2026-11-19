// On-demand, dual-stack resolution of RESOLVED_FAMILY_HOSTNAMES (design doc
// §3.2.1): `dns.lookup` (the system resolver), never `dns.resolve4/6`, since
// it matches what the AI SDK's own connection sees. Not a fixed timer: an
// unmatched port-443 socket triggers a re-resolution, rate-limited to once
// per 10 minutes. A bounded 2s wait applies only to the triggering
// connection; later ticks never block on a resolution in flight.

import { lookup as dnsLookup } from 'node:dns/promises';
import { RESOLVED_FAMILY_HOSTNAMES, isFamilyActivelyMatched } from './provider-ranges.js';

const COOLDOWN_MS = 10 * 60 * 1000;
const BOUNDED_WAIT_MS = 2000;
// 24h bounded lifetime for a family verified stable, per the design doc.
const RESOLVED_SET_LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface Clock {
  now(): number;
}

const realClock: Clock = { now: () => Date.now() };

export interface LookupFn {
  (hostname: string): Promise<{ address: string }[]>;
}

async function systemLookupAll(hostname: string): Promise<{ address: string }[]> {
  // family: 0 returns whatever families the hostname actually has (IPv4,
  // IPv6, or both) rather than assuming every family publishes AAAA.
  return dnsLookup(hostname, { all: true, family: 0 });
}

export class FamilyResolver {
  private resolvedAt = 0;
  private hasResolvedOnce = false;
  private resolvedByFamily: Record<string, Set<string>> = {};
  private inFlight: Promise<void> | undefined;
  private readonly clock: Clock;
  private readonly lookupFn: LookupFn;

  constructor(opts: { clock?: Clock; lookupFn?: LookupFn } = {}) {
    this.clock = opts.clock ?? realClock;
    this.lookupFn = opts.lookupFn ?? systemLookupAll;
  }

  /** The currently-cached resolved set, or {} if nothing has resolved yet or
   * the cached set has expired past its 24h lifetime. Never triggers a lookup. */
  currentResolvedSet(): Record<string, Set<string>> {
    if (!this.hasResolvedOnce || this.clock.now() - this.resolvedAt > RESOLVED_SET_LIFETIME_MS) return {};
    return this.resolvedByFamily;
  }

  private withinCooldown(): boolean {
    return this.hasResolvedOnce && this.clock.now() - this.resolvedAt < COOLDOWN_MS;
  }

  // Triggers a full re-resolution of every actively-matched
  // RESOLVED_FAMILY_HOSTNAMES entry, unless the per-process cooldown is
  // still active (one trigger counts for the whole batch). Use
  // `resolveAndWait` to wait for this trigger's own result.
  triggerResolution(): void {
    if (this.withinCooldown() || this.inFlight) return;
    this.inFlight = this.doResolve();
  }

  private async doResolve(): Promise<void> {
    const next: Record<string, Set<string>> = {};
    const families = Object.keys(RESOLVED_FAMILY_HOSTNAMES).filter(isFamilyActivelyMatched);
    await Promise.all(
      families.map(async (family) => {
        const hostnames = RESOLVED_FAMILY_HOSTNAMES[family] ?? [];
        const addrs = new Set<string>();
        await Promise.all(
          hostnames.map(async (hostname) => {
            try {
              const results = await this.lookupFn(hostname);
              for (const r of results) addrs.add(r.address);
            } catch {
              // A resolution failure for one hostname never aborts the batch;
              // that family simply contributes no addresses this round.
            }
          }),
        );
        if (addrs.size > 0) next[family] = addrs;
      }),
    );
    this.resolvedByFamily = next;
    this.resolvedAt = this.clock.now();
    this.hasResolvedOnce = true;
    this.inFlight = undefined;
  }

  // For the connection that triggered a fresh lookup: triggers it (if not
  // already in cooldown/in-flight) and waits up to BOUNDED_WAIT_MS, then
  // returns whatever is current (possibly still empty - a disclosed gap).
  async resolveAndWait(): Promise<Record<string, Set<string>>> {
    this.triggerResolution();
    if (this.inFlight) {
      await Promise.race([
        this.inFlight,
        new Promise<void>((resolve) => setTimeout(resolve, BOUNDED_WAIT_MS)),
      ]);
    }
    return this.currentResolvedSet();
  }
}
