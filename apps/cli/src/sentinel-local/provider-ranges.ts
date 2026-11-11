// Provider-owned IP ranges and resolvable provider hostnames for the
// destination-evidence classifier. PROVIDER_OWNED_RANGES contains ONLY
// ranges a provider itself publishes as its own allocation (RDAP, or the
// provider's own published list) - never a CDN/hyperscaler range, however
// narrow: a shared IP can answer for an unrelated zone at any moment and is
// not evidence of anything.

export interface ProviderOwnedRange {
  family: string;
  cidr: string;
  source: string;
  checked_at: string;
}

// As of 27 Oct 2026: Anthropic's own published allocation (RDAP: Anthropic,
// PBC) plus its published IPv6 block. Do not add anything else here without
// the same provider-published verification.
export const PROVIDER_OWNED_RANGES: ProviderOwnedRange[] = [
  {
    family: 'anthropic',
    cidr: '160.79.104.0/21',
    source: 'RDAP registrant: Anthropic, PBC',
    checked_at: '2026-10-27',
  },
  {
    family: 'anthropic',
    cidr: '2607:6bc0::/32',
    source: 'RDAP registrant: Anthropic, PBC (IPv6 allocation)',
    checked_at: '2026-10-27',
  },
];

// Hostnames resolved ON DEMAND (never on a fixed timer, never cached by
// honoring DNS TTL - see dns-resolver.ts). A match here is corroborating
// evidence ("talked to this family's edge"), never proof of calling the API:
// the same CDN edge can serve an unrelated zone (console/web app) from the
// same address.
export const RESOLVED_FAMILY_HOSTNAMES: Record<string, string[]> = {
  openai: ['api.openai.com'],
  mistral: ['api.mistral.ai'],
  groq: ['api.groq.com'],
  together: ['api.together.xyz', 'api.together.ai'],
  openrouter: ['openrouter.ai'],
  google: ['generativelanguage.googleapis.com'],
  cohere: ['api.cohere.ai', 'api.cohere.com'],
  // No fixed hostname set: Bedrock uses rotating regional endpoints with no
  // stable resolved set, so it is deliberately excluded from active matching.
  bedrock: [],
  anthropic: ['api.anthropic.com'],
};

/** Whether a family's resolved hostname set has been verified, on real
 * traffic, to stay stable across repeated lookups minutes apart. A family
 * behind a rotating, unpublished pool (bedrock) must stay `null` here and
 * excluded from active matching. */
export const RESOLVED_FAMILY_VERIFIED_STABLE: Record<string, string | null> = {
  openai: '2026-10-27',
  together: '2026-10-27',
  openrouter: '2026-10-27',
  google: '2026-10-27',
  cohere: '2026-10-27',
  anthropic: '2026-10-27',
  mistral: '2026-10-27',
  groq: '2026-10-27',
  bedrock: null,
};

/** True when `family`'s resolved hostnames are eligible for active
 * `resolved_exact_ip` matching (i.e. verified stable, not just listed). */
export function isFamilyActivelyMatched(family: string): boolean {
  return RESOLVED_FAMILY_VERIFIED_STABLE[family] != null;
}

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return undefined;
    const n = Number(p);
    if (n > 255) return undefined;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

/** Expands an IPv6 address (with optional `::` compression and an optional
 * embedded IPv4 tail) to a 128-bit BigInt, or undefined if unparsable. */
function ipv6ToBigInt(ip: string): bigint | undefined {
  let addr = ip;
  // Strip a zone id (fe80::1%eth0) - never meaningful for a remote peer address.
  const pct = addr.indexOf('%');
  if (pct !== -1) addr = addr.slice(0, pct);

  let head: string[];
  let tail: string[];
  const doubleColon = addr.indexOf('::');
  if (doubleColon !== -1) {
    const left = addr.slice(0, doubleColon);
    const right = addr.slice(doubleColon + 2);
    head = left.length > 0 ? left.split(':') : [];
    tail = right.length > 0 ? right.split(':') : [];
  } else {
    head = addr.split(':');
    tail = [];
  }

  // An embedded IPv4 tail (::ffff:1.2.3.4) appears as the last group.
  const expandV4Tail = (groups: string[]): string[] => {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.includes('.')) {
      const v4 = ipv4ToInt(last);
      if (v4 === undefined) return groups;
      const hi = ((v4 >>> 16) & 0xffff).toString(16);
      const lo = (v4 & 0xffff).toString(16);
      return [...groups.slice(0, -1), hi, lo];
    }
    return groups;
  };
  head = expandV4Tail(head);
  tail = expandV4Tail(tail);

  const missing = 8 - (head.length + tail.length);
  if (doubleColon === -1 && missing !== 0) return undefined;
  if (doubleColon !== -1 && missing < 0) return undefined;
  const groups = doubleColon !== -1 ? [...head, ...Array(missing).fill('0'), ...tail] : head;
  if (groups.length !== 8) return undefined;

  let out = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
    out = (out << 16n) | BigInt(parseInt(g, 16));
  }
  return out;
}

function isIpv6Literal(ip: string): boolean {
  return ip.includes(':');
}

/** Whether `ip` falls inside `cidr`. Supports IPv4-in-IPv4 and IPv6-in-IPv6
 * only (a v4 address is never checked against a v6 range or vice versa). */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [base, prefixStr] = cidr.split('/');
  if (base === undefined || prefixStr === undefined) return false;
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0) return false;

  if (isIpv6Literal(base)) {
    if (!isIpv6Literal(ip)) return false;
    if (prefix > 128) return false;
    const ipInt = ipv6ToBigInt(ip);
    const baseInt = ipv6ToBigInt(base);
    if (ipInt === undefined || baseInt === undefined) return false;
    const mask = prefix === 0 ? 0n : (((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix));
    return (ipInt & mask) === (baseInt & mask);
  }

  if (isIpv6Literal(ip)) return false;
  if (prefix > 32) return false;
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === undefined || baseInt === undefined) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) >>> 0 === (baseInt & mask) >>> 0;
}

export interface DestinationClassification {
  evidence: 'provider_owned_range' | 'resolved_exact_ip';
  family: string;
}

/** Checks `ip` against the static provider-owned ranges only (no DNS). */
export function classifyAgainstOwnedRanges(ip: string): DestinationClassification | undefined {
  for (const range of PROVIDER_OWNED_RANGES) {
    if (ipInCidr(ip, range.cidr)) return { evidence: 'provider_owned_range', family: range.family };
  }
  return undefined;
}

/** Checks `ip` against a resolved-hostname address set (already looked up by
 * the caller via dns-resolver.ts), restricted to actively-matched families. */
export function classifyAgainstResolvedSet(
  ip: string,
  resolvedByFamily: Record<string, Set<string>>,
): DestinationClassification | undefined {
  for (const [family, addrs] of Object.entries(resolvedByFamily)) {
    if (!isFamilyActivelyMatched(family)) continue;
    if (addrs.has(ip)) return { evidence: 'resolved_exact_ip', family };
  }
  return undefined;
}
