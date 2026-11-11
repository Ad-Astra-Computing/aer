import { describe, it, expect } from 'vitest';
import { classifyDestination } from './destination.js';
import { FamilyResolver } from './dns-resolver.js';

describe('classifyDestination', () => {
  it('matches a provider-owned-range IP without touching DNS', async () => {
    const resolver = new FamilyResolver({ lookupFn: async () => { throw new Error('should not be called'); } });
    const result = await classifyDestination('160.79.104.1', 443, resolver, { triggeredThisConnection: true });
    expect(result).toEqual({ evidence: 'provider_owned_range', family: 'anthropic' });
  });

  it('resolves and matches a known hostname IP on port 443', async () => {
    const resolver = new FamilyResolver({
      lookupFn: async (h) => (h === 'api.openai.com' ? [{ address: '9.9.9.9' }] : []),
    });
    const result = await classifyDestination('9.9.9.9', 443, resolver, { triggeredThisConnection: true });
    expect(result).toEqual({ evidence: 'resolved_exact_ip', family: 'openai' });
  });

  it('is none for a non-443 connection with no owned-range match', async () => {
    const resolver = new FamilyResolver({ lookupFn: async () => [] });
    const result = await classifyDestination('9.9.9.9', 8080, resolver, { triggeredThisConnection: true });
    expect(result).toEqual({ evidence: 'none', family: null });
  });

  it('is none for an unmatched port-443 connection with no resolution', async () => {
    const resolver = new FamilyResolver({ lookupFn: async () => [] });
    const result = await classifyDestination('1.2.3.4', 443, resolver, { triggeredThisConnection: true });
    expect(result).toEqual({ evidence: 'none', family: null });
  });

  it('a later tick reuses the already-resolved set with no wait', async () => {
    const resolver = new FamilyResolver({
      lookupFn: async (h) => (h === 'api.openai.com' ? [{ address: '9.9.9.9' }] : []),
    });
    await resolver.resolveAndWait();
    const result = await classifyDestination('9.9.9.9', 443, resolver, { triggeredThisConnection: false });
    expect(result).toEqual({ evidence: 'resolved_exact_ip', family: 'openai' });
  });
});
