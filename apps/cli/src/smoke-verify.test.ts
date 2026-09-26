import { describe, it, expect } from 'vitest';
import { collectorApiKey, listSessionIds, awaitNewSession } from './smoke-verify.js';

describe('collectorApiKey', () => {
  // doctor, smoke and the collector must read the same variable, or smoke can
  // pass the checks and then launch a collector with no key.
  it('reads AER_API_KEY, then AER_TENANT_API_KEY, and ignores empty values', () => {
    expect(collectorApiKey({ AER_API_KEY: 'a', AER_TENANT_API_KEY: 't' })).toBe('a');
    expect(collectorApiKey({ AER_TENANT_API_KEY: 't' })).toBe('t');
    expect(collectorApiKey({ AER_API_KEY: '', AER_TENANT_API_KEY: 't' })).toBe('t');
    expect(collectorApiKey({})).toBeUndefined();
  });
});

type Row = { agent_session_id: string; status: string; agent_id?: string };

function fakeApi(pages: Row[][], seen: string[] = []): typeof fetch {
  let i = 0;
  return (async (url: string | URL, init?: RequestInit) => {
    seen.push(`${String(url)} ${new Headers(init?.headers).get('authorization')}`);
    const rows = pages[Math.min(i, pages.length - 1)] ?? [];
    i += 1;
    return new Response(JSON.stringify({ sessions: rows, next_cursor: null }), { status: 200 });
  }) as typeof fetch;
}

const noSleep = async (): Promise<void> => undefined;

describe('listSessionIds', () => {
  it('asks for the agent\'s sessions with the key', async () => {
    const seen: string[] = [];
    const ids = await listSessionIds({ baseUrl: 'http://api.test/', apiKey: 'k', agentId: 'ag-1', fetchImpl: fakeApi([[{ agent_session_id: 's1', status: 'completed' }]], seen) });
    expect([...ids]).toEqual(['s1']);
    expect(seen).toEqual(['http://api.test/v1/sessions?agent_id=ag-1&limit=50 Bearer k']);
  });

  it('throws when the API refuses', async () => {
    const f = (async () => new Response('{"error":"unauthorized"}', { status: 401 })) as unknown as typeof fetch;
    await expect(listSessionIds({ baseUrl: 'http://api.test', apiKey: 'k', fetchImpl: f })).rejects.toThrow('401');
  });
});

describe('awaitNewSession', () => {
  const base = { baseUrl: 'http://api.test', apiKey: 'k', agentId: 'ag-1', timeoutMs: 1000, sleep: noSleep };

  it('returns null when no new session ever appears', async () => {
    const before = new Set(['old']);
    const r = await awaitNewSession({ ...base, before, fetchImpl: fakeApi([[{ agent_session_id: 'old', status: 'completed' }]]) });
    expect(r).toBeNull();
  });

  it('waits for the new session to complete', async () => {
    const before = new Set(['old']);
    const r = await awaitNewSession({
      ...base,
      before,
      fetchImpl: fakeApi([
        [{ agent_session_id: 'old', status: 'completed' }],
        [{ agent_session_id: 'new', status: 'running' }, { agent_session_id: 'old', status: 'completed' }],
        [{ agent_session_id: 'new', status: 'completed' }, { agent_session_id: 'old', status: 'completed' }],
      ]),
    });
    expect(r).toEqual({ id: 'new', status: 'completed' });
  });

  it('reports a new session that never completed with its last status', async () => {
    const r = await awaitNewSession({ ...base, before: new Set(), fetchImpl: fakeApi([[{ agent_session_id: 'new', status: 'running' }]]) });
    expect(r).toEqual({ id: 'new', status: 'running' });
  });
});
