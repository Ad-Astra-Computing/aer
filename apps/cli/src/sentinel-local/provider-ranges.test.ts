import { describe, it, expect } from 'vitest';
import {
  ipInCidr,
  classifyAgainstOwnedRanges,
  classifyAgainstResolvedSet,
  isFamilyActivelyMatched,
  normalizeIp,
  PROVIDER_OWNED_RANGES,
} from './provider-ranges.js';

describe('ipInCidr', () => {
  it('matches an IPv4 address inside the range', () => {
    expect(ipInCidr('160.79.104.5', '160.79.104.0/21')).toBe(true);
    expect(ipInCidr('160.79.111.255', '160.79.104.0/21')).toBe(true);
  });

  it('rejects an IPv4 address outside the range', () => {
    expect(ipInCidr('160.79.112.0', '160.79.104.0/21')).toBe(false);
    expect(ipInCidr('1.2.3.4', '160.79.104.0/21')).toBe(false);
  });

  it('matches an IPv6 address inside the range', () => {
    expect(ipInCidr('2607:6bc0::1', '2607:6bc0::/32')).toBe(true);
    expect(ipInCidr('2607:6bc0:ffff:ffff::1', '2607:6bc0::/32')).toBe(true);
  });

  it('rejects an IPv6 address outside the range', () => {
    expect(ipInCidr('2607:6bc1::1', '2607:6bc0::/32')).toBe(false);
  });

  it('never matches a v4 address against a v6 range or vice versa', () => {
    expect(ipInCidr('1.2.3.4', '2607:6bc0::/32')).toBe(false);
    expect(ipInCidr('2607:6bc0::1', '160.79.104.0/21')).toBe(false);
  });
});

describe('classifyAgainstOwnedRanges', () => {
  it('finds Anthropic for an owned-range IP', () => {
    expect(classifyAgainstOwnedRanges('160.79.104.1')).toEqual({
      evidence: 'provider_owned_range',
      family: 'anthropic',
    });
  });

  it('never flags a CDN/hyperscaler IP', () => {
    expect(classifyAgainstOwnedRanges('1.1.1.1')).toBeUndefined();
    expect(classifyAgainstOwnedRanges('8.8.8.8')).toBeUndefined();
  });

  it('contains only Anthropic ranges', () => {
    expect(PROVIDER_OWNED_RANGES.every((r) => r.family === 'anthropic')).toBe(true);
  });

  it('matches a bracketed macOS IPv6 literal (B7)', () => {
    expect(classifyAgainstOwnedRanges('[2607:6bc0::1]')).toEqual({
      evidence: 'provider_owned_range',
      family: 'anthropic',
    });
  });

  it('matches a Linux v4-mapped tcp6 literal against the IPv4 owned range (B7)', () => {
    expect(classifyAgainstOwnedRanges('0:0:0:0:0:ffff:a04f:6801')).toEqual({
      evidence: 'provider_owned_range',
      family: 'anthropic',
    });
  });
});

describe('normalizeIp', () => {
  it('strips brackets', () => {
    expect(normalizeIp('[2607:6bc0::1]')).toBe('2607:6bc0::1');
  });

  it('collapses an IPv4-mapped IPv6 address to plain IPv4', () => {
    expect(normalizeIp('0:0:0:0:0:ffff:a04f:6801')).toBe('160.79.104.1');
    expect(normalizeIp('::ffff:160.79.104.1')).toBe('160.79.104.1');
  });

  it('leaves a plain v4 or non-mapped v6 address untouched', () => {
    expect(normalizeIp('160.79.104.1')).toBe('160.79.104.1');
    expect(normalizeIp('2607:6bc0::1')).toBe('2607:6bc0::1');
  });
});

describe('classifyAgainstResolvedSet', () => {
  it('matches a resolved IP for an actively-matched family', () => {
    const result = classifyAgainstResolvedSet('1.2.3.4', { openai: new Set(['1.2.3.4']) });
    expect(result).toEqual({ evidence: 'resolved_exact_ip', family: 'openai' });
  });

  it('never matches bedrock (not actively matched)', () => {
    expect(isFamilyActivelyMatched('bedrock')).toBe(false);
    const result = classifyAgainstResolvedSet('1.2.3.4', { bedrock: new Set(['1.2.3.4']) });
    expect(result).toBeUndefined();
  });

  it('returns undefined when nothing matches', () => {
    expect(classifyAgainstResolvedSet('9.9.9.9', { openai: new Set(['1.2.3.4']) })).toBeUndefined();
  });

  it('matches compressed vs uncompressed IPv6 forms as equal (B7)', () => {
    const result = classifyAgainstResolvedSet('2607:6bc0::1', { anthropic: new Set(['2607:6bc0:0:0:0:0:0:1']) });
    expect(result).toEqual({ evidence: 'resolved_exact_ip', family: 'anthropic' });
  });

  it('matches a bracketed candidate against an unbracketed resolved entry (B7)', () => {
    const result = classifyAgainstResolvedSet('[2607:6bc0::1]', { anthropic: new Set(['2607:6bc0::1']) });
    expect(result).toEqual({ evidence: 'resolved_exact_ip', family: 'anthropic' });
  });
});
