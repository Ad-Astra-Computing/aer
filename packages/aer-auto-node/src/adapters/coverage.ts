// Did the provider calls that happened actually pass through our wrapper?
//
// "We patched something" is a fact about the collector. A record needs a fact
// about the traffic. The transport patches see every request by host, so a
// session with requests to a provider and no LLM events from its adapter is a
// contradiction the record should carry rather than hide.

export type AdapterStatus = 'patched' | 'absent' | 'failed' | 'unsupported';
export type Coverage = 'confirmed' | 'idle' | 'contradicted' | 'unverifiable';

/** Default hosts per adapter. A custom base URL is simply not judged. */
export const PROVIDER_HOSTS: Readonly<Record<string, readonly string[]>> = {
  openai: ['api.openai.com'],
  anthropic: ['api.anthropic.com'],
  'vercel-provider': [
    'api.openai.com',
    'api.anthropic.com',
    'generativelanguage.googleapis.com',
    'api.mistral.ai',
    'api.groq.com',
  ],
};

interface EventLike {
  event_type: string;
  payload?: unknown;
}

/** Outbound requests this session made to an adapter's known provider hosts. */
export function countProviderTraffic(events: readonly EventLike[], adapter: string): number {
  const hosts = PROVIDER_HOSTS[adapter];
  if (!hosts || hosts.length === 0) return 0;
  let n = 0;
  for (const event of events) {
    // Requests only: a completion is the same call counted twice.
    if (event.event_type !== 'http.requested') continue;
    const payload = event.payload as Record<string, unknown> | undefined;
    const raw = payload?.['host'];
    if (typeof raw !== 'string') continue;
    // The transport records host[:port].
    const host = raw.split(':')[0]?.toLowerCase() ?? '';
    if (hosts.includes(host)) n += 1;
  }
  return n;
}

export interface CoverageInput {
  status: AdapterStatus;
  callsRecorded: number;
  providerTraffic: number;
  /** Whether an http or fetch patch was installed to see the traffic at all. */
  transportWatching: boolean;
  /** Whether our wrapper is still the installed method at session close. */
  patchIntact?: boolean;
}

/**
 * The verdict for one adapter. `contradicted` is the one that matters: it
 * means the record would otherwise have claimed coverage it did not have.
 */
export function deriveCoverage(input: CoverageInput): Coverage {
  // An adapter that never installed makes no claim, so there is nothing to
  // contradict, whatever the traffic was.
  if (input.status !== 'patched') return 'unverifiable';

  // Someone replaced the method after us, so calls after that point were
  // never seen and a recorded count does not settle anything.
  if (input.patchIntact === false) return 'contradicted';

  if (input.callsRecorded > 0) return 'confirmed';
  if (!input.transportWatching) return 'unverifiable';
  return input.providerTraffic > 0 ? 'contradicted' : 'idle';
}
