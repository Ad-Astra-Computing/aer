/**
 * opencode plugin factory - one AER session sink per opencode session, tool events
 * emitted across the session, completed on session.deleted / dispose. Uses a fake
 * sink so no network or opencode runtime is needed. Locks fail-open + bodies-off.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { EventSink, HttpSinkOptions } from '@adastracomputing/aer-emit';
import { createAerOpencodeHooks, aerOpencodePlugin } from './opencode-plugin.js';
import { HOOKS_VERSION } from './version.generated.js';

interface FakeSink extends EventSink {
  emitted: Array<{ type: string; payload: Record<string, unknown> }>;
  closed: number;
}

function fakeSinkFactory() {
  const sinks: FakeSink[] = [];
  const opener = (_opts: HttpSinkOptions): EventSink => {
    const s: FakeSink = {
      emitted: [],
      closed: 0,
      emit(type, payload) { s.emitted.push({ type, payload }); },
      async close() { s.closed += 1; },
    };
    sinks.push(s);
    return s;
  };
  return { opener, sinks };
}

const BASE: HttpSinkOptions = { baseUrl: 'https://api.test', apiKey: 'k' };

describe('createAerOpencodeHooks', () => {
  it('emits tool.started + tool.completed to one sink per session, completing on delete', async () => {
    const { opener, sinks } = fakeSinkFactory();
    const hooks = createAerOpencodeHooks({ base: BASE, openSink: opener });

    await hooks['tool.execute.before']!({ tool: 'bash', sessionID: 's1', callID: 'c1' }, { args: { command: 'ls' } });
    await hooks['tool.execute.after']!({ tool: 'bash', sessionID: 's1', callID: 'c1', args: { command: 'ls' } }, { title: 't', output: 'o', metadata: {} });

    expect(sinks.length).toBe(1); // one AER session for opencode session s1
    const types = sinks[0]!.emitted.map((e) => e.type);
    expect(types).toContain('tool.started');
    expect(types).toContain('tool.completed');
    expect(sinks[0]!.closed).toBe(0); // still running

    await hooks.event!({ event: { type: 'session.deleted', properties: { info: { id: 's1' } } } });
    expect(sinks[0]!.closed).toBe(1); // completed on delete
  });

  it('keeps distinct sinks for distinct opencode sessions', async () => {
    const { opener, sinks } = fakeSinkFactory();
    const hooks = createAerOpencodeHooks({ base: BASE, openSink: opener });
    await hooks['tool.execute.before']!({ tool: 'read', sessionID: 's1', callID: 'c1' }, { args: {} });
    await hooks['tool.execute.before']!({ tool: 'read', sessionID: 's2', callID: 'c2' }, { args: {} });
    expect(sinks.length).toBe(2);
  });

  it('dispose completes every still-open session', async () => {
    const { opener, sinks } = fakeSinkFactory();
    const hooks = createAerOpencodeHooks({ base: BASE, openSink: opener });
    await hooks['tool.execute.before']!({ tool: 'bash', sessionID: 's1', callID: 'c1' }, { args: {} });
    await hooks['tool.execute.before']!({ tool: 'bash', sessionID: 's2', callID: 'c2' }, { args: {} });
    await hooks.dispose!();
    expect(sinks.every((s) => s.closed === 1)).toBe(true);
  });

  it('does not leak argument values by default (bodies-off)', async () => {
    const { opener, sinks } = fakeSinkFactory();
    const hooks = createAerOpencodeHooks({ base: BASE, openSink: opener, env: {} as NodeJS.ProcessEnv });
    await hooks['tool.execute.before']!({ tool: 'bash', sessionID: 's1', callID: 'c1' }, { args: { command: 'rm -rf /SECRET' } });
    const blob = JSON.stringify(sinks[0]!.emitted);
    expect(blob).toContain('command'); // key name present
    expect(blob).not.toContain('SECRET'); // value absent
  });

  it('never throws on malformed hook input', async () => {
    const { opener } = fakeSinkFactory();
    const hooks = createAerOpencodeHooks({ base: BASE, openSink: opener });
    await expect(hooks['tool.execute.before']!({} as never, {} as never)).resolves.toBeUndefined();
    await expect(hooks.event!({ event: null })).resolves.toBeUndefined();
    await expect(hooks.event!({ event: { type: 'lsp.updated' } })).resolves.toBeUndefined();
  });

  function assistantMsg(over: Record<string, unknown> = {}) {
    return {
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_1', sessionID: 's1', role: 'assistant',
            modelID: 'claude-sonnet-5', providerID: 'anthropic',
            time: { created: 1 }, cost: 0,
            tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
            ...over,
          },
        },
      },
    };
  }

  it('emits llm.requested once and llm.completed once across streaming message.updated', async () => {
    const { opener, sinks } = fakeSinkFactory();
    const hooks = createAerOpencodeHooks({ base: BASE, openSink: opener });

    // The same assistant message updates several times as it streams...
    await hooks.event!(assistantMsg());
    await hooks.event!(assistantMsg({ tokens: { input: 100, output: 40 } }));
    // ...then completes.
    await hooks.event!(assistantMsg({ time: { created: 1, completed: 2 }, tokens: { input: 100, output: 55 } }));

    const emitted = sinks[0]!.emitted;
    expect(emitted.filter((e) => e.type === 'llm.requested')).toHaveLength(1);
    const completed = emitted.filter((e) => e.type === 'llm.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]!.payload).toMatchObject({
      model: 'claude-sonnet-5', provider: 'anthropic', ok: true, streaming: true,
      input_tokens: 100, output_tokens: 55,
    });
  });

  it('routes each opencode session\'s LLM events to its own sink', async () => {
    const { opener, sinks } = fakeSinkFactory();
    const hooks = createAerOpencodeHooks({ base: BASE, openSink: opener });
    await hooks.event!(assistantMsg({ id: 'm_a', sessionID: 's1' }));
    await hooks.event!(assistantMsg({ id: 'm_b', sessionID: 's2' }));
    expect(sinks).toHaveLength(2);
  });

  it('does not leak assistant message content, only model + token metadata', async () => {
    const { opener, sinks } = fakeSinkFactory();
    const hooks = createAerOpencodeHooks({ base: BASE, openSink: opener });
    await hooks.event!(assistantMsg({ content: 'SECRET chain of thought', time: { created: 1, completed: 2 } }));
    const blob = JSON.stringify(sinks[0]!.emitted);
    expect(blob).toContain('claude-sonnet-5'); // model present
    expect(blob).not.toContain('SECRET');      // content absent
  });
});

describe('what an opencode record carries', () => {
  it('records the programs a bash call ran and the file a read opened', async () => {
    const { opener, sinks } = fakeSinkFactory();
    const hooks = createAerOpencodeHooks({ base: BASE, openSink: opener });
    await hooks['tool.execute.before']!({ tool: 'bash', sessionID: 's1', callID: 'c1' }, { args: { command: 'cat a.txt | grep SECRET_VALUE', description: 'd' } });
    await hooks['tool.execute.before']!({ tool: 'read', sessionID: 's1', callID: 'c2' }, { args: { filePath: '/w/a.txt' } });
    const emitted = sinks[0]!.emitted;
    expect(emitted.filter((e) => e.type === 'process.exec').map((e) => e.payload['command'])).toEqual(['cat', 'grep']);
    expect(emitted.filter((e) => e.type === 'file.opened').map((e) => e.payload['path'])).toEqual(['/w/a.txt']);
    expect(emitted.every((e) => e.payload['harness'] === 'opencode')).toBe(true);
    expect(JSON.stringify(emitted)).not.toContain('SECRET_VALUE');
  });

  it('marks the end of each session on dispose, then completes it', async () => {
    const { opener, sinks } = fakeSinkFactory();
    const hooks = createAerOpencodeHooks({ base: BASE, openSink: opener });
    await hooks.event!({ event: { type: 'session.created', properties: { info: { id: 's1' } } } });
    await hooks.dispose!();
    const reports = sinks[0]!.emitted.filter((e) => e.type === 'collector.report');
    expect(reports.map((r) => [r.payload['phase'], r.payload['harness'], r.payload['session_ref']])).toEqual([
      ['session_start', 'opencode', 's1'],
      ['session_end', 'opencode', 's1'],
    ]);
    expect(sinks[0]!.closed).toBe(1);
  });
});

describe('the session aerOpencodePlugin opens', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('declares the aer-hooks collector and the harness source, as the shell hooks do', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      const u = String(url);
      if (u.endsWith('/v1/sessions')) return new Response(JSON.stringify({ agent_session_id: 'as1', ingest_token: 'it' }), { status: 201 });
      return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
    });
    const env = {
      AER_BASE_URL: 'https://api.test', AER_API_KEY: 'k',
      AER_TENANT_ID: 't', AER_AGENT_ID: 'a', AER_ENV_ID: 'e',
    } as unknown as NodeJS.ProcessEnv;
    const hooks = await aerOpencodePlugin(undefined, undefined, env);
    await hooks['tool.execute.before']!({ tool: 'bash', sessionID: 's1', callID: 'c1' }, { args: { command: 'ls' } });
    await hooks.dispose!();
    const open = calls.find((c) => c.url.endsWith('/v1/sessions'))?.body as Record<string, unknown>;
    expect(open['collector']).toEqual({ name: 'aer-hooks', version: HOOKS_VERSION });
    const events = calls.filter((c) => c.url.endsWith('/events')).flatMap((c) => c.body as Array<Record<string, unknown>>);
    expect(events.length).toBeGreaterThan(0);
    expect(new Set(events.map((e) => e['source_type']))).toEqual(new Set(['harness']));
  });
});

describe('aerOpencodePlugin', () => {
  it('returns empty (no-op) hooks when emit is unconfigured', async () => {
    const hooks = await aerOpencodePlugin(undefined, undefined, {} as NodeJS.ProcessEnv);
    expect(hooks).toEqual({});
  });

  it('returns live hooks when the environment configures a sink', async () => {
    const env = {
      AER_BASE_URL: 'https://api.test',
      AER_API_KEY: 'k',
      AER_TENANT_ID: 't', AER_AGENT_ID: 'a', AER_ENV_ID: 'e',
    } as unknown as NodeJS.ProcessEnv;
    const hooks = await aerOpencodePlugin(undefined, undefined, env);
    expect(typeof hooks['tool.execute.before']).toBe('function');
    expect(typeof hooks.dispose).toBe('function');
  });
});
