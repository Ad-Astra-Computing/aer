// ADR-023 Phase B: root-session join (B1) and the hook budget (B2).
//
// A harness fires the hook once per event as a SEPARATE process, so these
// drive runHook repeatedly against a SHARED cache dir (via XDG_CACHE_HOME),
// mirroring the pattern in cli.test.ts's cross-invocation suite.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runHook, type RunHookDeps } from './cli.js';
import { deriveClientRef } from '@adastracomputing/aer-emit';

const CONFIGURED = {
  AER_API_KEY: 'k',
  AER_TENANT_ID: 't',
  AER_AGENT_ID: 'agent-1',
  AER_BASE_URL: 'https://api.test',
} as NodeJS.ProcessEnv;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('ADR-023 B1: root-session join and the no-lead-no-open rule', () => {
  let cacheDir: string;
  let opens: number;
  let openBodies: Array<Record<string, unknown>>;
  let eventSessionIds: string[];
  let fetchImpl: typeof fetch;

  function envWith(): NodeJS.ProcessEnv {
    return { ...CONFIGURED, XDG_CACHE_HOME: cacheDir } as NodeJS.ProcessEnv;
  }

  function fire(payload: Record<string, unknown>, deps: RunHookDeps = {}): Promise<void> {
    return runHook(['--harness', 'claude-code', '--lifecycle', 'v2'], envWith(), {
      readInput: async () => JSON.stringify(payload),
      fetch: fetchImpl,
      ...deps,
    });
  }

  function fireWithRoot(payload: Record<string, unknown>, root: string, deps: RunHookDeps = {}): Promise<void> {
    return runHook(['--harness', 'claude-code', '--lifecycle', 'v2', '--root-session', root], envWith(), {
      readInput: async () => JSON.stringify(payload),
      fetch: fetchImpl,
      ...deps,
    });
  }

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aer-hooks-root-'));
    opens = 0;
    openBodies = [];
    eventSessionIds = [];
    fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/sessions')) {
        opens += 1;
        openBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return jsonResponse({ agent_session_id: `sess-${opens}`, ingest_token: `tok-${opens}`, status: 'running' }, 201);
      }
      if (url.endsWith('/complete')) return jsonResponse({ ok: true });
      const m = /\/v1\/sessions\/([^/]+)\/events$/.exec(url);
      if (m) eventSessionIds.push(m[1]!);
      return jsonResponse({ accepted: 1, rejected: 0 }, 202);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('a subagent tool call keyed on --root-session joins the lead session, not a new one', async () => {
    const lead = 'lead-session-1';
    const sub = 'subagent-session-9';
    await fireWithRoot({ hook_event_name: 'SessionStart', session_id: lead }, lead);
    await fireWithRoot(
      { hook_event_name: 'PreToolUse', session_id: sub, tool_name: 'Bash', tool_input: {}, agent_id: 'agent-42', agent_type: 'Explore' },
      lead,
    );
    expect(opens).toBe(1);
    expect(new Set(eventSessionIds)).toEqual(new Set(['sess-1']));
  });

  it('sends client_ref derived from harness + root session + agent id on open', async () => {
    const lead = 'lead-session-cr';
    await fireWithRoot({ hook_event_name: 'SessionStart', session_id: lead }, lead);
    expect(opens).toBe(1);
    const expected = deriveClientRef('claude-code', lead, 'agent-1');
    expect(openBodies[0]?.['client_ref']).toBe(expected);
  });

  it('a subagent event with no root-session and no lead anywhere is dropped, never opens', async () => {
    // No SessionStart ever fired, and no --root-session on this invocation:
    // the pid-alias walk (via a harmless ownPpid override) finds nothing.
    await fire(
      { hook_event_name: 'PreToolUse', session_id: 'orphan-subagent', tool_name: 'Bash', tool_input: {}, agent_id: 'agent-7' },
      { ownPpid: 999999, parentPidOf: () => undefined },
    );
    expect(opens).toBe(0);
    expect(eventSessionIds).toHaveLength(0);
  });

  it('the pid-alias fallback finds the lead when --root-session is absent', async () => {
    const leadPpid = 4242;
    const lead = 'lead-session-pid';
    // Lead's own SessionStart, invoked (as far as the hook can tell) from
    // harness process `leadPpid`, with no --root-session (simulating an
    // older/partial registration or a harness that does not propagate it).
    await fire({ hook_event_name: 'SessionStart', session_id: lead }, { ownPpid: leadPpid });
    // A subagent tool call from a DIFFERENT session_id, invoked from the SAME
    // harness process (same ownPpid), also with no --root-session.
    await fire(
      { hook_event_name: 'PreToolUse', session_id: 'sub-1', tool_name: 'Bash', tool_input: {}, agent_id: 'agent-42' },
      { ownPpid: leadPpid },
    );
    expect(opens).toBe(1);
    expect(new Set(eventSessionIds)).toEqual(new Set(['sess-1']));
  });

  it('the pid-alias fallback walks up to three ancestors', async () => {
    const lead = 'lead-session-ancestors';
    // SessionStart's own parent is pid 100; the subagent hook's own parent is
    // 300, whose ancestors are 200 then 100 (the same harness process, three
    // hops up).
    await fire({ hook_event_name: 'SessionStart', session_id: lead }, { ownPpid: 100 });
    const parentPidOf = (pid: number): number | undefined => (pid === 300 ? 200 : pid === 200 ? 100 : undefined);
    await fire(
      { hook_event_name: 'PreToolUse', session_id: 'sub-2', tool_name: 'Bash', tool_input: {}, agent_id: 'agent-8' },
      { ownPpid: 300, parentPidOf },
    );
    expect(opens).toBe(1);
    expect(new Set(eventSessionIds)).toEqual(new Set(['sess-1']));
  });

  // Review P2: an alias whose store entry is already gone (the session ended
  // or expired) must be cleaned up and skipped, not returned as a live lead.
  it('skips and deletes a dead alias, falling through to a live one further up', async () => {
    const lead = 'lead-session-alive';
    await fire({ hook_event_name: 'SessionStart', session_id: lead }, { ownPpid: 400 });
    const store = await import('./session-store.js');
    // A dead alias at the FIRST candidate pid, pointing at a session that no
    // longer exists.
    store.savePidAlias('500', 'long-gone-session', envWith(), Date.now());
    expect(store.loadPidAlias('500', envWith(), Date.now())).toBe('long-gone-session');

    const parentPidOf = (pid: number): number | undefined => (pid === 500 ? 400 : undefined);
    await fire(
      { hook_event_name: 'PreToolUse', session_id: 'sub-alive', tool_name: 'Bash', tool_input: {}, agent_id: 'agent-8' },
      { ownPpid: 500, parentPidOf },
    );
    expect(opens).toBe(1);
    expect(new Set(eventSessionIds)).toEqual(new Set(['sess-1']));
    // The dead alias was deleted along the way.
    expect(store.loadPidAlias('500', envWith(), Date.now())).toBeNull();
  });

  // Review P2: an alias written for a different agent must never be trusted,
  // even if its store key happens to point at a live session.
  it('refuses a pid alias written for a different agent', async () => {
    const lead = 'lead-session-other-agent';
    await fire({ hook_event_name: 'SessionStart', session_id: lead }, { ownPpid: 600 });
    const eventsAfterLeadStart = eventSessionIds.length;

    // A subagent hook under a DIFFERENT AER_AGENT_ID reusing the same pid.
    const otherAgentEnv = { ...envWith(), AER_AGENT_ID: 'agent-different' };
    await runHook(['--harness', 'claude-code', '--lifecycle', 'v2'], otherAgentEnv, {
      readInput: async () =>
        JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sub-other-agent', tool_name: 'Bash', tool_input: {}, agent_id: 'agent-8' }),
      fetch: fetchImpl,
      ownPpid: 600,
    });
    // Refused the alias, found no lead of its own, and dropped rather than
    // attaching to the wrong agent's session: no open and no new event.
    expect(opens).toBe(1);
    expect(eventSessionIds).toHaveLength(eventsAfterLeadStart);
  });

  it('a subagent event with a matching root-session does not open even when it arrives first', async () => {
    // The subagent's hook fires before the lead's SessionStart is ever seen
    // by this store (e.g. scheduling), but the lead has already opened
    // upstream in a real run; here nothing has opened yet, so this must drop.
    const lead = 'lead-never-started';
    await fireWithRoot(
      { hook_event_name: 'PreToolUse', session_id: 'sub-early', tool_name: 'Bash', tool_input: {}, agent_id: 'agent-1' },
      lead,
    );
    expect(opens).toBe(0);
  });

  it('folds subagent_events_unattached into the closing collector.report', async () => {
    const lead = 'lead-with-drops';
    await fireWithRoot({ hook_event_name: 'SessionStart', session_id: lead }, lead);
    // An unattached subagent event against a DIFFERENT, never-opened key: this
    // exercises the counter file, not the lead's own session.
    await fire(
      { hook_event_name: 'PreToolUse', session_id: 'stray-subagent', tool_name: 'Bash', tool_input: {}, agent_id: 'agent-9' },
      { ownPpid: 555555, parentPidOf: () => undefined },
    );
    // The stray counter is keyed to its own (never-opened) store slot, so it
    // never reaches this lead's closing report - the point of this assertion
    // is that ending the LEAD's own session does not throw or hang.
    await fireWithRoot({ hook_event_name: 'SessionEnd', session_id: lead }, lead);
    expect(opens).toBe(1);
  });

  // Review P1: a subagent event with no session_id at all (agent_id present,
  // ref absent) used to fall straight into the correlation-less single-shot
  // path and open its own session.
  it('a subagent event with agent_id but no session_id never opens', async () => {
    await fire({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, agent_id: 'agent-99' });
    expect(opens).toBe(0);
  });

  // Review P1: a subagent event that loses the lock race on a NON-tool kind
  // (e.g. SubagentStop) used to fall into the single-shot degrade path and
  // open its own session, same as the ref-absent case above.
  it('a subagent event that loses the lock on a non-tool kind never opens', async () => {
    // A real session must already exist at storeKey first: otherwise the
    // alias-walk-finds-nothing branch (an earlier, separate guard) drops the
    // event before this invocation ever reaches the lock at all, and the
    // lock-lost path this test targets is never exercised.
    const sid = 'lock-lost-subagent-session';
    await fireWithRoot({ hook_event_name: 'SessionStart', session_id: sid }, sid);
    expect(opens).toBe(1);

    const { acquireSessionLock } = await import('./session-store.js');
    const held = await acquireSessionLock(sid, envWith());
    expect(held).not.toBeNull();

    await fireWithRoot(
      { hook_event_name: 'SubagentStop', session_id: 'sub-of-' + sid, agent_id: 'agent-77' },
      sid,
      { hardTimeoutMs: 700 },
    );
    held?.release();
    // Still just the one open from SessionStart: the lock-lost subagent event
    // dropped instead of minting a second session.
    expect(opens).toBe(1);
  });
});

describe('ADR-023 B2: a tool event that loses the lock race never opens', () => {
  let cacheDir: string;
  let opens: number;
  let closingReports: Array<Record<string, unknown>>;
  let fetchImpl: typeof fetch;

  function envWith(): NodeJS.ProcessEnv {
    return { ...CONFIGURED, XDG_CACHE_HOME: cacheDir } as NodeJS.ProcessEnv;
  }

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aer-hooks-budget-'));
    opens = 0;
    closingReports = [];
    fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/sessions')) {
        opens += 1;
        return jsonResponse({ agent_session_id: `sess-${opens}`, ingest_token: `tok-${opens}`, status: 'running' }, 201);
      }
      if (url.endsWith('/complete')) return jsonResponse({ ok: true });
      const m = /\/v1\/sessions\/([^/]+)\/events$/.exec(url);
      if (m) {
        const batch = JSON.parse(String(init?.body ?? '[]')) as Array<{ event_type: string; payload: Record<string, unknown> }>;
        for (const e of batch) if (e.event_type === 'collector.report' && e.payload['phase'] === 'session_end') closingReports.push(e.payload);
      }
      return jsonResponse({ accepted: 1, rejected: 0 }, 202);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('polls the store, gives up at the budget deadline, drops, and counts it on the closing report', async () => {
    const sid = 'budget-race-session';
    const { acquireSessionLock } = await import('./session-store.js');
    // Hold the lock for the whole poll window so the tool event can never
    // converge on it, and nothing ever appears in the store either.
    const held = await acquireSessionLock(sid, envWith());
    expect(held).not.toBeNull();

    await runHook(['--harness', 'claude-code', '--lifecycle', 'v2'], envWith(), {
      readInput: async () =>
        JSON.stringify({ hook_event_name: 'PreToolUse', session_id: sid, tool_name: 'Bash', tool_input: {} }),
      fetch: fetchImpl,
      hardTimeoutMs: 700,
    });
    held?.release();
    expect(opens).toBe(0);

    // Now the lead actually starts and ends; the closing report carries the
    // drop this invocation counted, even though it ran in an earlier process.
    await runHook(['--harness', 'claude-code', '--lifecycle', 'v2'], envWith(), {
      readInput: async () => JSON.stringify({ hook_event_name: 'SessionStart', session_id: sid }),
      fetch: fetchImpl,
    });
    await runHook(['--harness', 'claude-code', '--lifecycle', 'v2'], envWith(), {
      readInput: async () => JSON.stringify({ hook_event_name: 'SessionEnd', session_id: sid }),
      fetch: fetchImpl,
    });

    expect(closingReports).toHaveLength(1);
    expect(closingReports[0]?.['events_dropped_budget']).toBe(1);
  });
});

// Only one invocation at a time talks to the server for a harness session.
// The rest queue their events and leave, so a slow or hung open never makes
// the next events open again (each such open mints a token toward the
// server's cap of 16) and never makes them wait on it either.
describe('an open in flight in another invocation', () => {
  let cacheDir: string;
  let opens: number;
  let openBodies: Array<Record<string, unknown>>;
  let posted: number;
  let fetchImpl: typeof fetch;

  function envWith(): NodeJS.ProcessEnv {
    return { ...CONFIGURED, XDG_CACHE_HOME: cacheDir } as NodeJS.ProcessEnv;
  }

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aer-hooks-lease-'));
    opens = 0;
    posted = 0;
    openBodies = [];
    fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/sessions')) {
        opens += 1;
        openBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return jsonResponse({ agent_session_id: `sess-${opens}`, ingest_token: `tok-${opens}`, status: 'running' }, 201);
      }
      if (url.endsWith('/events')) posted += (JSON.parse(String(init?.body ?? '[]')) as unknown[]).length;
      return jsonResponse({ accepted: 1, rejected: 0 }, 202);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('queues events fired meanwhile without opening again, and a lapsed claim reopens with the identical client_ref', async () => {
    const lead = 'lead-in-flight';
    const store = await import('./session-store.js');
    const clientRef = deriveClientRef('claude-code', lead, 'agent-1');
    // Another invocation is opening right now: it holds the network role.
    store.saveState(lead, { ...store.freshState(Date.now()), lease: { owner: 'other.1', until: Date.now() + 60_000 } }, envWith());

    for (let i = 0; i < 5; i++) {
      const t = Date.now();
      await runHook(['--harness', 'claude-code', '--lifecycle', 'v2', '--root-session', lead], envWith(), {
        readInput: async () => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: lead, tool_name: 'Bash', tool_input: { command: 'ls' } }),
        fetch: fetchImpl,
      });
      expect(Date.now() - t).toBeLessThan(1000);
    }
    expect(opens).toBe(0);
    expect(store.loadState(lead, envWith())?.outbox).toHaveLength(10);

    // The other invocation was killed: its claim lapses, and the next event
    // opens with the same client_ref and sends everything queued.
    const st = store.loadState(lead, envWith())!;
    st.lease = { owner: 'other.1', until: Date.now() - 1 };
    store.saveState(lead, st, envWith());
    await runHook(['--harness', 'claude-code', '--lifecycle', 'v2', '--root-session', lead], envWith(), {
      readInput: async () => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: lead, tool_name: 'Bash', tool_input: { command: 'ls' } }),
      fetch: fetchImpl,
    });
    expect(opens).toBe(1);
    expect(openBodies[0]?.['client_ref']).toBe(clientRef);
    expect(posted).toBe(12);
  });
});
