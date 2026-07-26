import { describe, it, expect, vi } from 'vitest';
import { createAttestor } from './attestor.js';
import type { ProtectedResource } from './config.js';

const res = (over: Partial<ProtectedResource> = {}): ProtectedResource =>
  ({ host: 'mcp.internal', audience: 'mcp://aud', scopes: [], enforcement: 'off', onUnavailable: 'fail_closed', dpop: false, ...over });
const RESOURCES: ProtectedResource[] = [res()];
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('createAttestor', () => {
  describe('audienceFor', () => {
    it('returns the audience for a configured protected host, null otherwise', () => {
      const att = createAttestor({ resources: RESOURCES, getAttestationFor: async () => null, peekAttestationFor: () => null });
      expect(att.audienceFor('mcp.internal')).toBe('mcp://aud');
      expect(att.audienceFor('api.openai.com')).toBeNull();
    });

    it('returns null when no protected resources are configured', () => {
      const att = createAttestor({ resources: [], getAttestationFor: async () => null, peekAttestationFor: () => null });
      expect(att.audienceFor('mcp.internal')).toBeNull();
    });
  });

  describe('getToken (fetch path)', () => {
    it('returns the awaited token without counting a miss', async () => {
      const att = createAttestor({ resources: RESOURCES, getAttestationFor: async () => 'jwt-1', peekAttestationFor: () => null });
      expect(await att.getToken('mcp://aud', [])).toBe('jwt-1');
      expect(att.stats.cache_miss).toBe(0);
    });

    it('counts a cache miss when no token is produced', async () => {
      const att = createAttestor({ resources: RESOURCES, getAttestationFor: async () => null, peekAttestationFor: () => null });
      expect(await att.getToken('mcp://aud', [])).toBeNull();
      expect(att.stats.cache_miss).toBe(1);
    });

    it('never throws when the mint rejects; counts a miss', async () => {
      const att = createAttestor({ resources: RESOURCES, getAttestationFor: async () => { throw new Error('boom'); }, peekAttestationFor: () => null });
      expect(await att.getToken('mcp://aud', [])).toBeNull();
      expect(att.stats.cache_miss).toBe(1);
    });

    it('passes the caller-provided scopes straight through to the session (NOT audience-derived)', async () => {
      const getAttestationFor = vi.fn(async () => 'jwt');
      const att = createAttestor({ resources: RESOURCES, getAttestationFor, peekAttestationFor: () => null });
      await att.getToken('mcp://aud', ['tools.read', 'tools.write']);
      expect(getAttestationFor).toHaveBeenCalledWith('mcp://aud', ['tools.read', 'tools.write'], false);
    });

    it('two resources sharing an audience keep distinct scope sets (no cross-cache)', async () => {
      // Scope must come from the matched resource, not the first
      // resource that happens to share the audience.
      const shared: ProtectedResource[] = [
        res({ host: 'a.test', audience: 'mcp://shared', scopes: ['read'] }),
        res({ host: 'b.test', audience: 'mcp://shared', scopes: ['write'] }),
      ];
      const getAttestationFor = vi.fn(async () => 'jwt');
      const att = createAttestor({ resources: shared, getAttestationFor, peekAttestationFor: () => null });
      await att.getToken('mcp://shared', att.resourceFor('a.test')!.scopes);
      await att.getToken('mcp://shared', att.resourceFor('b.test')!.scopes);
      expect(getAttestationFor).toHaveBeenNthCalledWith(1, 'mcp://shared', ['read'], false);
      expect(getAttestationFor).toHaveBeenNthCalledWith(2, 'mcp://shared', ['write'], false);
    });
  });

  describe('peekToken (http path)', () => {
    it('returns a cached token without warming or counting a miss', async () => {
      const getAttestationFor = vi.fn(async () => 'should-not-be-called');
      const att = createAttestor({ resources: RESOURCES, getAttestationFor, peekAttestationFor: () => 'cached-jwt' });
      expect(att.peekToken('mcp://aud', [])).toBe('cached-jwt');
      await flush();
      expect(getAttestationFor).not.toHaveBeenCalled();
      expect(att.stats.cache_miss).toBe(0);
    });

    it('on a cold miss returns null, counts a miss, and warms the cache with the given scopes', async () => {
      const getAttestationFor = vi.fn(async () => 'warmed-jwt');
      const att = createAttestor({ resources: RESOURCES, getAttestationFor, peekAttestationFor: () => null });
      expect(att.peekToken('mcp://aud', ['tools.read'])).toBeNull();
      expect(att.stats.cache_miss).toBe(1);
      await flush();
      expect(getAttestationFor).toHaveBeenCalledWith('mcp://aud', ['tools.read'], false);
      expect(att.stats.warm_failed).toBe(0);
    });

    it('counts warm_failed when the background warm yields no token', async () => {
      const att = createAttestor({ resources: RESOURCES, getAttestationFor: async () => null, peekAttestationFor: () => null });
      att.peekToken('mcp://aud', []);
      await flush();
      expect(att.stats.warm_failed).toBe(1);
    });

    it('counts warm_failed when the background warm rejects (never throws)', async () => {
      const att = createAttestor({ resources: RESOURCES, getAttestationFor: async () => { throw new Error('down'); }, peekAttestationFor: () => null });
      expect(() => att.peekToken('mcp://aud', [])).not.toThrow();
      await flush();
      expect(att.stats.warm_failed).toBe(1);
    });
  });

  it('recordInjected increments the injected counter', () => {
    const att = createAttestor({ resources: RESOURCES, getAttestationFor: async () => null, peekAttestationFor: () => null });
    att.recordInjected();
    att.recordInjected();
    expect(att.stats.injected).toBe(2);
  });

  it('recordCrossOriginStripped / recordManualFallback increment their counters', () => {
    const att = createAttestor({ resources: RESOURCES, getAttestationFor: async () => null, peekAttestationFor: () => null });
    att.recordCrossOriginStripped();
    att.recordManualFallback();
    att.recordManualFallback();
    expect(att.stats.redirect_cross_origin_stripped).toBe(1);
    expect(att.stats.redirect_manual_fallback).toBe(2);
  });

  describe('resourceFor', () => {
    it('returns the matched resource (with enforcement), null otherwise', () => {
      const resources = [res({ enforcement: 'block' })];
      const att = createAttestor({ resources, getAttestationFor: async () => null, peekAttestationFor: () => null });
      expect(att.resourceFor('mcp.internal')?.enforcement).toBe('block');
      expect(att.resourceFor('api.openai.com')).toBeNull();
    });
  });

  describe('evaluateEgress', () => {
    const tokenWithScopes = (scp: string[]) => {
      const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
      return `h.${b64({ scp })}.s`;
    };

    it('off resource: allows, bumps no egress counter', () => {
      const att = createAttestor({ resources: [res()], getAttestationFor: async () => null, peekAttestationFor: () => null });
      const d = att.evaluateEgress(res({ enforcement: 'off' }), null);
      expect(d.allow).toBe(true);
      expect(att.stats.egress_blocked).toBe(0);
    });

    it('block + no token: blocks and bumps egress_blocked', () => {
      const att = createAttestor({ resources: [res()], getAttestationFor: async () => null, peekAttestationFor: () => null });
      const d = att.evaluateEgress(res({ enforcement: 'block' }), null);
      expect(d.allow).toBe(false);
      expect(att.stats.egress_blocked).toBe(1);
    });

    it('block + insufficient scope: blocks, bumps egress_blocked AND egress_insufficient_scope', () => {
      const att = createAttestor({ resources: [res()], getAttestationFor: async () => null, peekAttestationFor: () => null });
      const d = att.evaluateEgress(res({ enforcement: 'block', scopes: ['w'] }), tokenWithScopes(['r']));
      expect(d.allow).toBe(false);
      expect(att.stats.egress_blocked).toBe(1);
      expect(att.stats.egress_insufficient_scope).toBe(1);
    });

    it('report + no token: allows, bumps egress_would_block', () => {
      const att = createAttestor({ resources: [res()], getAttestationFor: async () => null, peekAttestationFor: () => null });
      const d = att.evaluateEgress(res({ enforcement: 'report' }), null);
      expect(d.allow).toBe(true);
      expect(att.stats.egress_would_block).toBe(1);
    });

    it('block + fail_open + no token: allows, bumps egress_unavailable_fail_open', () => {
      const att = createAttestor({ resources: [res()], getAttestationFor: async () => null, peekAttestationFor: () => null });
      const d = att.evaluateEgress(res({ enforcement: 'block', onUnavailable: 'fail_open' }), null);
      expect(d.allow).toBe(true);
      expect(att.stats.egress_unavailable_fail_open).toBe(1);
    });
  });
});
