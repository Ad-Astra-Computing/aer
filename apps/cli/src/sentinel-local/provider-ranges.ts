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

/** Normalizes a remote address before any range/set match: strips a macOS
 * lsof-style `[...]` bracket wrapper (and any zone id already handled by
 * ipv6ToBigInt), and collapses an IPv4-mapped IPv6 form (e.g. Linux
 * /proc/net/tcp6's `0:0:0:0:0:ffff:a04f:6801`, or the bracketed macOS
 * literal `::ffff:160.79.104.1`) down to plain IPv4 - so a v4-mapped v6
 * address matches an IPv4 CIDR/resolved-set entry instead of silently never
 * matching because the two sides disagree on family. */
export function normalizeIp(ip: string): string {
  let addr = ip.trim();
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
  if (!isIpv6Literal(addr)) return addr;

  const value = ipv6ToBigInt(addr);
  if (value === undefined) return addr;

  // ::ffff:a.b.c.d: top 96 bits are zero except the 5th hextet, which is
  // 0xffff. Checking `value >> 32n === 0xffffn` is exactly that: the top 96
  // bits, as a number, equal 0xffff only when bits 32-111 are all zero
  // except the low 16 of that range (the 0xffff hextet itself).
  if ((value >> 32n) === 0xffffn) {
    const v4Int = Number(value & 0xffffffffn);
    return [
      (v4Int >>> 24) & 0xff,
      (v4Int >>> 16) & 0xff,
      (v4Int >>> 8) & 0xff,
      v4Int & 0xff,
    ].join('.');
  }
  return addr;
}

/** Canonical form for IPv6 EQUALITY comparisons (never range matching,
 * which already goes through ipInCidr's own bigint math): collapses
 * compressed vs uncompressed forms (`2607:6bc0::1` vs
 * `2607:6bc0:0:0:0:0:0:1`) to the same key, so a resolved-hostname set never
 * misses a match purely over string formatting. */
function canonicalForEquality(ip: string): string {
  const normalized = normalizeIp(ip);
  if (!isIpv6Literal(normalized)) return normalized;
  const value = ipv6ToBigInt(normalized);
  return value !== undefined ? `v6:${value.toString()}` : normalized;
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
  const normalized = normalizeIp(ip);
  for (const range of PROVIDER_OWNED_RANGES) {
    if (ipInCidr(normalized, range.cidr)) return { evidence: 'provider_owned_range', family: range.family };
  }
  return undefined;
}

/** Checks `ip` against a resolved-hostname address set (already looked up by
 * the caller via dns-resolver.ts), restricted to actively-matched families.
 * Compares by normalized value (bracket-stripped, v4-mapped-collapsed, and
 * for IPv6, by BigInt value) - never by raw string equality, which misses a
 * bracketed or differently-compressed form of the very same address. */
export function classifyAgainstResolvedSet(
  ip: string,
  resolvedByFamily: Record<string, Set<string>>,
): DestinationClassification | undefined {
  const target = canonicalForEquality(ip);
  for (const [family, addrs] of Object.entries(resolvedByFamily)) {
    if (!isFamilyActivelyMatched(family)) continue;
    for (const addr of addrs) {
      if (canonicalForEquality(addr) === target) return { evidence: 'resolved_exact_ip', family };
    }
  }
  return undefined;
}
