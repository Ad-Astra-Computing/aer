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

export interface AdapterRow {
  name: string;
  status: AdapterStatus;
  calls_recorded: number;
  provider_requests: number;
  coverage: Coverage;
}

export interface AdapterRowsInput {
  /** Adapters that actually patched something. */
  patched: readonly string[];
  /** Adapters the configuration asked for, patched or not. */
  configured: readonly string[];
  /** Calls each adapter recorded. */
  calls: Readonly<Record<string, number>>;
  events: readonly EventLike[];
  transportWatching: boolean;
  /** Adapters whose wrapper is no longer the installed method. */
  replaced?: readonly string[];
}

/**
 * One evidence row per adapter.
 *
 * A host more than one patched adapter could have called proves nothing about
 * either, so it is counted but never used to contradict. Reporting a coverage
 * failure that did not happen is as damaging to a record as missing one.
 */
export function adapterRows(input: AdapterRowsInput): AdapterRow[] {
  const claims = new Map<string, number>();
  for (const name of input.patched) {
    for (const host of PROVIDER_HOSTS[name] ?? []) claims.set(host, (claims.get(host) ?? 0) + 1);
  }

  const names = [...new Set([...input.configured, ...input.patched])].sort();
  return names.map((name) => {
    const status: AdapterStatus = input.patched.includes(name) ? 'patched' : 'absent';
    const callsRecorded = input.calls[name] ?? 0;
    const hosts = PROVIDER_HOSTS[name] ?? [];
    const own = hosts.filter((h) => (claims.get(h) ?? 0) <= 1);
    const ownTraffic = countHostTraffic(input.events, own);
    const allTraffic = countHostTraffic(input.events, hosts);
    const shared = allTraffic > ownTraffic;

    const coverage = deriveCoverage({
      status,
      callsRecorded,
      providerTraffic: ownTraffic,
      ...(input.replaced?.includes(name) === true ? { patchIntact: false } : {}),
      // A shared host cannot settle it either way.
      transportWatching: input.transportWatching && !(shared && ownTraffic === 0),
    });
    return { name, status, calls_recorded: callsRecorded, provider_requests: allTraffic, coverage };
  });
}

function countHostTraffic(events: readonly EventLike[], hosts: readonly string[]): number {
  if (hosts.length === 0) return 0;
  let n = 0;
  for (const event of events) {
    if (event.event_type !== 'http.requested') continue;
    const raw = (event.payload as Record<string, unknown> | undefined)?.['host'];
    if (typeof raw !== 'string') continue;
    if (hosts.includes(raw.split(':')[0]?.toLowerCase() ?? '')) n += 1;
  }
  return n;
}
