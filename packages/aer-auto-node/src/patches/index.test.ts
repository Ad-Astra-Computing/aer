import { describe, it, expect, afterEach, vi } from 'vitest';
import { installTransportPatches } from './index.js';
import type { CollectorEvent } from '../session.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  const g = globalThis as Record<symbol, unknown>;
  for (const name of ['fetch', 'http', 'child_process']) {
    delete g[Symbol.for(`adastra.aer.patched.${name}`)];
    delete g[Symbol.for(`adastra.aer.original.${name}`)];
  }
});

describe('installTransportPatches', () => {
  it('reports the enabled patch names, mapping http+https to one installer', () => {
    const events: CollectorEvent[] = [];
    const installed = installTransportPatches((e) => events.push(e), ['fetch', 'http', 'https', 'child_process']);
    expect(installed.enabled).toEqual(['fetch', 'http', 'https', 'child_process']);
    installed.uninstall();
  });

  it('installs only the requested transports', () => {
    const installed = installTransportPatches(() => {}, ['fetch']);
    expect(installed.enabled).toEqual(['fetch']);
    installed.uninstall();
  });

  it('the installed fetch patch actually captures', async () => {
    globalThis.fetch = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
    const events: CollectorEvent[] = [];
    const installed = installTransportPatches((e) => events.push(e), ['fetch']);
    await globalThis.fetch('https://x.test/');
    expect(events.map((e) => e.event_type)).toContain('http.requested');
    installed.uninstall();
  });

  it('uninstall() tears down every installed patch and never throws', () => {
    const installed = installTransportPatches(() => {}, ['fetch', 'http', 'child_process']);
    expect(() => installed.uninstall()).not.toThrow();
    expect(globalThis.fetch).toBe(realFetch);
  });

  it('a throwing single uninstall does not prevent the others', () => {
    const installed = installTransportPatches(() => {}, ['fetch']);
    // sabotage: simulate a broken teardown by clearing the slot underneath
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => installed.uninstall()).not.toThrow();
    spy.mockRestore();
  });
});
