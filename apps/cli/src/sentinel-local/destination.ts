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
  if (owned) return { evidence: 'provider_owned_range', family: owned.family };

  if (remotePort !== 443) return { evidence: 'none', family: null };

  const resolvedSet = opts.triggeredThisConnection
    ? await resolver.resolveAndWait()
    : resolver.currentResolvedSet();
  const resolved = classifyAgainstResolvedSet(remoteIp, resolvedSet);
  if (resolved) return { evidence: 'resolved_exact_ip', family: resolved.family };

  return { evidence: 'none', family: null };
}
