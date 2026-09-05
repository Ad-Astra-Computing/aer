import { describe, it, expect } from 'vitest';
import { AdapterStats } from './stats.js';
import { wrapCreate, type ProviderConfig } from './llm-core.js';
import type { CollectorEvent } from '../session.js';

describe('AdapterStats', () => {
  it('starts empty and snapshots nothing', () => {
    const stats = new AdapterStats();
    expect(stats.empty).toBe(true);
    expect(stats.snapshot()).toEqual({});
  });

  it('counts calls, ok, error and tool selections per provider', () => {
    const stats = new AdapterStats();
    stats.record('openai', 'call');
    stats.record('openai', 'ok');
    stats.record('openai', 'tool');
    stats.record('openai', 'tool');
    stats.record('anthropic', 'call');
    stats.record('anthropic', 'error');

    expect(stats.empty).toBe(false);
    expect(stats.snapshot()).toEqual({
      openai: { calls: 1, ok: 1, error: 0, tool_selections: 2 },
      anthropic: { calls: 1, ok: 0, error: 1, tool_selections: 0 },
    });
  });

  it('snapshot is a copy: later records do not mutate an old snapshot', () => {
    const stats = new AdapterStats();
    stats.record('openai', 'call');
    const snap = stats.snapshot();
    stats.record('openai', 'call');
    expect(snap['openai']).toEqual({ calls: 1, ok: 0, error: 0, tool_selections: 0 });
  });
});

const cfg: ProviderConfig = {
  provider: 'testllm',
  extractRequest: (args) => {
    const p = args[0] as { model?: string } | undefined;
    return p?.model ? { provider: 'testllm', model: p.model } : null;
  },
  extractResponse: (response) => {
    const r = response as { usage?: { in?: number }; tools?: string[] } | null;
    if (!r || typeof r !== 'object' || !('usage' in r)) return null;
    return { tool_names: r.tools ?? [] };
  },
};

describe('wrapCreate with stats', () => {
  it('records call + ok + a tool selection on a successful call', async () => {
    const stats = new AdapterStats();
    const capture = (_e: CollectorEvent): void => undefined;
    const original = async () => ({ usage: { in: 1 }, tools: ['search'] });
    const wrapped = wrapCreate(original, cfg, capture, stats);

    await wrapped({ model: 'm' });
    await Promise.resolve();

    expect(stats.snapshot()).toEqual({
      testllm: { calls: 1, ok: 1, error: 0, tool_selections: 1 },
    });
  });

  it('records call + error when the call rejects', async () => {
    const stats = new AdapterStats();
    const wrapped = wrapCreate(async () => { throw new Error('boom'); }, cfg, () => undefined, stats);
    await expect(wrapped({ model: 'm' })).rejects.toThrow('boom');
    await Promise.resolve();
    expect(stats.snapshot()).toEqual({
      testllm: { calls: 1, ok: 0, error: 1, tool_selections: 0 },
    });
  });

  it('works without a stats object (backward compatible)', async () => {
    const events: CollectorEvent[] = [];
    const wrapped = wrapCreate(async () => ({ usage: { in: 1 }, tools: [] }), cfg, (e) => events.push(e));
    await wrapped({ model: 'm' });
    await Promise.resolve();
    expect(events.map((e) => e.event_type)).toEqual(['llm.requested', 'llm.completed']);
  });
});
