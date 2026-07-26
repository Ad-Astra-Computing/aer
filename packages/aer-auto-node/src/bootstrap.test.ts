import { describe, it, expect, vi, afterEach } from 'vitest';
import { bootstrap, isConfigured } from './bootstrap.js';
import { resolveConfig } from './config.js';
import { getActiveCollector, setActiveCollector } from './state.js';
import type { Collector } from './collector.js';

const CONFIGURED_ENV = {
  AER_API_KEY: 'k', AER_TENANT_ID: 't', AER_AGENT_ID: 'a', AER_ENV_ID: 'e',
};

function fakeCollector(): Collector {
  return {
    config: resolveConfig({ env: CONFIGURED_ENV }),
    // minimal session stub
    session: { capture() {}, async flush() {}, async complete() {}, async abort() {}, async getAttestationFor() { return null; }, peekAttestationFor() { return null; }, state: 'idle' },
    capture() {},
    async getAttestationFor() { return null; },
    peekAttestationFor() { return null; },
    async complete() {},
    async abort() {},
    async withSession(_opts, fn) { return fn(); },
    uninstall() {},
    enabledPatches: [],
    enabledAdapters: [],
  };
}

afterEach(() => setActiveCollector(null));

describe('isConfigured', () => {
  it('requires apiKey + tenantId + agentId + envId', () => {
    expect(isConfigured(resolveConfig({ env: CONFIGURED_ENV }))).toBe(true);
    expect(isConfigured(resolveConfig({ env: { AER_API_KEY: 'k' } }))).toBe(false);
    expect(isConfigured(resolveConfig({ env: {} }))).toBe(false);
  });
});

describe('bootstrap', () => {
  it('does nothing when AER_DISABLE=1 (kill switch)', () => {
    const installHooks = vi.fn();
    const createColl = vi.fn(fakeCollector);
    const result = bootstrap({
      env: { ...CONFIGURED_ENV, AER_DISABLE: '1' },
      cwd: '/nonexistent',
      installHooks,
      createColl,
    });
    expect(result).toBeNull();
    expect(createColl).not.toHaveBeenCalled();
    expect(installHooks).not.toHaveBeenCalled();
    expect(getActiveCollector()).toBeNull();
  });

  it('does nothing when identity is incomplete', () => {
    const installHooks = vi.fn();
    const result = bootstrap({
      env: { AER_API_KEY: 'k' }, // missing tenant/agent/env
      cwd: '/nonexistent',
      installHooks,
      createColl: vi.fn(fakeCollector),
    });
    expect(result).toBeNull();
    expect(installHooks).not.toHaveBeenCalled();
  });

  it('creates + registers the collector and installs lifecycle hooks when configured', () => {
    const installHooks = vi.fn();
    const coll = fakeCollector();
    const result = bootstrap({
      env: CONFIGURED_ENV,
      cwd: '/nonexistent',
      installHooks,
      createColl: () => coll,
    });
    expect(result).toBe(coll);
    expect(getActiveCollector()).toBe(coll);
    expect(installHooks).toHaveBeenCalledWith(coll);
  });
});
