// Combines the static owned-range check with the on-demand resolver to
// produce destination evidence for one observed remote address (design doc
// §3.2, §3.2.1). Match order: owned range first (high confidence), then a
// resolved-hostname exact match (corroborating, never upgraded), else 'none'.

import { classifyAgainstOwnedRanges, classifyAgainstResolvedSet } from './provider-ranges.js';
import type { DestinationEvidence } from './types.js';
import type { FamilyResolver } from './dns-resolver.js';

export interface DestinationResult {
  evidence: DestinationEvidence;
  family: string | null;
  /** True only when this call actually invoked the resolver's bounded-wait
   * trigger (the owned-range short-circuit and the non-443 short-circuit
   * never touch DNS at all, regardless of `triggeredThisConnection`). The
   * caller (poll-tick.ts) must consume its once-per-tick trigger budget
   * from THIS, never from the mere intent to try (B2). */
  triggeredResolution: boolean;
}

// `triggeredThisConnection` means this call is the one that should
// bound-wait on its own trigger (the connection that first caused the
// lookup); a later tick's socket reuses whatever is already resolved.
export async function classifyDestination(
  remoteIp: string,
  remotePort: number,
  resolver: FamilyResolver,
  opts: { triggeredThisConnection: boolean },
): Promise<DestinationResult> {
  const owned = classifyAgainstOwnedRanges(remoteIp);
  if (owned) return { evidence: 'provider_owned_range', family: owned.family, triggeredResolution: false };

  if (remotePort !== 443) return { evidence: 'none', family: null, triggeredResolution: false };

  const resolvedSet = opts.triggeredThisConnection
    ? await resolver.resolveAndWait()
    : resolver.currentResolvedSet();
  const resolved = classifyAgainstResolvedSet(remoteIp, resolvedSet);
  const triggeredResolution = opts.triggeredThisConnection;
  if (resolved) return { evidence: 'resolved_exact_ip', family: resolved.family, triggeredResolution };

  return { evidence: 'none', family: null, triggeredResolution };
}
