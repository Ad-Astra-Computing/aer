import { describe, it, expect } from 'vitest';
import { installAdapters } from './index.js';
import type { CollectorEvent } from '../session.js';

function capt() {
  const events: CollectorEvent[] = [];
  return { capture: (e: CollectorEvent) => events.push(e), events };
}

describe('installAdapters', () => {
  it('enables only adapters whose SDK resolves, and reports their names', () => {
    const openaiProto = { create: async () => ({ model: 'm', usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
    const { capture } = capt();
    const installed = installAdapters(capture, ['openai', 'anthropic'], {
      openai: { resolveProto: () => openaiProto },
      anthropic: { resolveProto: () => null }, // not installed
    });
    expect(installed.enabled).toEqual(['openai']);
    installed.uninstall();
  });

  it('ignores unknown adapter names', () => {
    const { capture } = capt();
    const installed = installAdapters(capture, ['bogus'], {});
    expect(installed.enabled).toEqual([]);
    installed.uninstall();
  });

  it('records per-provider activity in the shared stats when a wrapped call runs', async () => {
    const openaiProto = {
      create: async () => ({
        model: 'gpt-4o',
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ function: { name: 'search' } }] } }],
      }),
    };
    const { capture } = capt();
    const installed = installAdapters(capture, ['openai'], { openai: { resolveProto: () => openaiProto } });

    await (openaiProto.create as (a: unknown) => Promise<unknown>)({ model: 'gpt-4o' });
    await Promise.resolve();

    expect(installed.stats?.snapshot()).toEqual({
      openai: { calls: 1, ok: 1, error: 0, tool_selections: 1 },
    });
    installed.uninstall();
  });

  it('uninstall tears down every enabled adapter and never throws', () => {
    const proto = { create: async () => ({ model: 'm', usage: { input_tokens: 1, output_tokens: 1 } }) };
    const { capture } = capt();
    const installed = installAdapters(capture, ['anthropic'], { anthropic: { resolveProto: () => proto } });
    expect(installed.enabled).toEqual(['anthropic']);
    expect(() => installed.uninstall()).not.toThrow();
  });
});

describe('one SDK must never take the collector, or the app, down with it', () => {
  it('survives a module whose exports cannot be patched', () => {
    // An ESM module namespace is frozen. `ai` v7 is ESM, so a real customer
    // with the Vercel AI SDK installed hit `Cannot add property Symbol(...),
    // object is not extensible` inside register.js, before their app ran a
    // single line. A collector that cannot instrument something records
    // nothing for it; it does not stop the program.
    const frozen = Object.freeze({ generateText: () => 'real', streamText: () => 'real' });
    const events: CollectorEvent[] = [];

    const install = installAdapters((e) => events.push(e), ['vercel'], {
      vercel: { resolveProto: () => frozen },
    });

    expect(install.enabled).not.toContain('vercel');
    // The real function is untouched and still callable.
    expect(frozen.generateText()).toBe('real');
    install.uninstall();
  });

  it('still installs the adapters that do work', () => {
    const frozen = Object.freeze({ generateText: () => 'real' });
    const openaiProto = { create: async () => ({ model: 'm', usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
    const events: CollectorEvent[] = [];

    const install = installAdapters((e) => events.push(e), ['vercel', 'openai'], {
      vercel: { resolveProto: () => frozen },
      openai: { resolveProto: () => openaiProto },
    });

    expect(install.enabled).toContain('openai');
    expect(install.enabled).not.toContain('vercel');
    install.uninstall();
  });

  it('survives an adapter whose resolver throws outright', () => {
    const events: CollectorEvent[] = [];
    const install = installAdapters((e) => events.push(e), ['openai'], {
      openai: { resolveProto: () => { throw new Error('resolver exploded'); } },
    });
    expect(install.enabled).not.toContain('openai');
    install.uninstall();
  });
});
