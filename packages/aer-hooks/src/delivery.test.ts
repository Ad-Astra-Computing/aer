// How the hook gets events to the server when the server is slow, fails, or
// closes the session, and when the hook itself is cut off. Every case drives
// runHook against an in-process fake of the session API.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runHook, main, runDrain } from './cli.js';
import { FakeApi } from './fake-api.test-support.js';
import { loadState } from './session-store.js';

const V2 = ['--harness', 'claude-code', '--lifecycle', 'v2'];

let dir: string;
let cache: string;
let api: FakeApi;

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    AER_API_KEY: 'k',
    AER_TENANT_ID: 't',
    AER_AGENT_ID: 'agent-1',
    AER_ENV_ID: '01950000-0000-7000-8000-0000000000ad',
    AER_BASE_URL: 'http://aer.test',
    XDG_CACHE_HOME: cache,
    TMPDIR: path.join(dir, 'tmp'),
    // Never the developer's own: its harness config would count as registered.
    HOME: path.join(dir, 'home'),
    ...extra,
  } as NodeJS.ProcessEnv;
}

function fire(payload: Record<string, unknown>, opts: { env?: NodeJS.ProcessEnv; now?: number; hardTimeoutMs?: number; args?: string[] } = {}): Promise<void> {
  return runHook(opts.args ?? V2, opts.env ?? env(), {
    readInput: async () => JSON.stringify(payload),
    fetch: api.fetch,
    ...(opts.now !== undefined ? { now: () => opts.now! } : {}),
    ...(opts.hardTimeoutMs !== undefined ? { hardTimeoutMs: opts.hardTimeoutMs } : {}),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function storeFile(storeKey: string): string {
  const digest = createHash('sha256').update(storeKey).digest('hex').slice(0, 32);
  return path.join(cache, 'aer-hooks', `${digest}.json`);
}

/** A Claude Code transcript with `n` assistant messages carrying model and usage. */
function transcript(n: number, file = path.join(dir, 'transcript.jsonl')): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i += 1) {
    lines.push(JSON.stringify({ type: 'user', uuid: `u${i}`, message: { role: 'user', content: 'SECRET PROMPT' } }));
    lines.push(JSON.stringify({
      type: 'assistant',
      uuid: `a${i}`,
      message: { id: `msg_${i}`, model: 'claude-test-1', role: 'assistant', content: [{ type: 'text', text: 'SECRET REPLY' }], usage: { input_tokens: 10 + i, output_tokens: 5 } },
    }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

const seqsOf = (a: FakeApi): number[] =>
  a.allEvents().map((e) => e.payload['seq']).filter((s): s is number => typeof s === 'number').sort((x, y) => x - y);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aer-delivery-'));
  cache = path.join(dir, 'cache');
  fs.mkdirSync(path.join(dir, 'tmp'));
  api = new FakeApi();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the transcript backlog survives a failed send', () => {
  it('keeps model calls scanned before a failed POST queued, and sends each once later', async () => {
    const t = transcript(3);
    const base = { session_id: 'cc-1', transcript_path: t, cwd: dir };
    await fire({ ...base, hook_event_name: 'SessionStart' });
    api.fault({ path: /\/events$/, status: 500, times: 1 });
    await fire({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {} });
    expect(api.eventsOf('llm.completed')).toHaveLength(0);
    await fire({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
    const llm = api.eventsOf('llm.completed');
    expect(llm.map((e) => e.payload['input_tokens'])).toEqual([10, 11, 12]);
    expect(api.eventsOf('tool.completed')).toHaveLength(1);
    expect(JSON.stringify(api.allEvents())).not.toContain('SECRET');
  });

  it('records at most the recent backlog of a long transcript it first meets, in bounded batches', async () => {
    const t = transcript(400);
    await fire({ session_id: 'cc-2', transcript_path: t, cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/x' }, tool_response: {} });
    await fire({ session_id: 'cc-2', transcript_path: t, cwd: dir, hook_event_name: 'Stop' });
    const llm = api.eventsOf('llm.completed');
    expect(llm.length).toBeGreaterThan(0);
    expect(llm.length).toBeLessThanOrEqual(50);
    // The most recent calls, not the oldest.
    expect(llm[llm.length - 1]!.payload['input_tokens']).toBe(10 + 399);
    for (const post of api.eventPosts()) expect((post.body as unknown[]).length).toBeLessThanOrEqual(100);
    // A later scan does not go back for what the cap left out.
    const before = llm.length;
    await fire({ session_id: 'cc-2', transcript_path: t, cwd: dir, hook_event_name: 'Stop' });
    expect(api.eventsOf('llm.completed').length).toBe(before);
  });
});

describe('under production latency', () => {
  it('concurrent lead and subagent hooks lose nothing, repeat no seq and open once', async () => {
    api.openDelayMs = 2500;
    api.eventsDelayMs = 1500;
    const lead = { session_id: 'cc-lat', cwd: dir, permission_mode: 'default' };
    const sub = (id: string) => ({ ...lead, agent_id: id, agent_type: 'Explore' });
    const start = fire({ ...lead, hook_event_name: 'SessionStart' });
    await sleep(100);
    const rest = [
      { ...lead, hook_event_name: 'UserPromptSubmit' },
      { ...lead, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'l1' },
      { ...lead, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {}, tool_use_id: 'l1' },
      { ...sub('a1'), hook_event_name: 'SubagentStart' },
      { ...sub('a2'), hook_event_name: 'SubagentStart' },
      { ...sub('a1'), hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'x' }, tool_use_id: 's1' },
      { ...sub('a2'), hook_event_name: 'PreToolUse', tool_name: 'Glob', tool_input: { pattern: 'x' }, tool_use_id: 's2' },
      { ...sub('a1'), hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_input: { pattern: 'x' }, tool_response: {}, tool_use_id: 's1' },
      { ...sub('a2'), hook_event_name: 'PostToolUse', tool_name: 'Glob', tool_input: { pattern: 'x' }, tool_response: {}, tool_use_id: 's2' },
      { ...sub('a1'), hook_event_name: 'SubagentStop' },
      { ...sub('a2'), hook_event_name: 'SubagentStop' },
      { ...lead, hook_event_name: 'Stop' },
    ];
    await Promise.all([start, ...rest.map((p) => fire(p))]);
    await fire({ ...lead, hook_event_name: 'SessionEnd', reason: 'other' });

    expect(api.opens()).toHaveLength(1);
    expect(api.completes()).toHaveLength(1);
    expect(api.sessions.size).toBe(1);
    expect(api.eventsOf('tool.started')).toHaveLength(3);
    expect(api.eventsOf('tool.completed')).toHaveLength(3);
    const phases = api.eventsOf('collector.report').map((e) => e.payload['phase']);
    expect(phases.filter((p) => p === 'subagent_start')).toHaveLength(2);
    expect(phases.filter((p) => p === 'subagent_end')).toHaveLength(2);
    const seqs = seqsOf(api);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    const closing = api.eventsOf('collector.report').find((e) => e.payload['phase'] === 'session_end')!;
    expect(closing.payload['events_emitted']).toBe(closing.payload['seq']);
    expect(closing.payload['subagent_events_unattached']).toBeUndefined();
    expect(closing.payload['events_dropped_budget']).toBeUndefined();
  }, 30_000);

  it('never holds the session lock across a network call', async () => {
    api.openDelayMs = 50;
    api.eventsDelayMs = 50;
    const lockFile = `${storeFile('cc-lock')}.lock`;
    const heldDuring: string[] = [];
    api.onRequest = (method, p) => {
      if (fs.existsSync(lockFile)) heldDuring.push(`${method} ${p}`);
    };
    const lead = { session_id: 'cc-lock', cwd: dir };
    await fire({ ...lead, hook_event_name: 'SessionStart' });
    await Promise.all([
      fire({ ...lead, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'a' } }),
      fire({ ...lead, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'b' }, agent_id: 'x' }),
    ]);
    await fire({ ...lead, hook_event_name: 'SessionEnd' });
    expect(api.requests.length).toBeGreaterThan(3);
    expect(heldDuring).toEqual([]);
  });
});

describe('a session the server closed', () => {
  it('is replaced on the next event, with the same client_ref and no lost events', async () => {
    const lead = { session_id: 'cc-closed', cwd: dir };
    await fire({ ...lead, hook_event_name: 'SessionStart' });
    const first = [...api.sessions.keys()][0]!;
    api.terminate(first);
    await fire({ ...lead, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
    await fire({ ...lead, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {} });
    expect(api.sessions.size).toBe(2);
    const second = [...api.sessions.values()][1]!;
    expect(second.clientRef).toBe(api.sessions.get(first)!.clientRef);
    expect(second.events.map((e) => e.event_type)).toEqual(['tool.started', 'process.exec', 'tool.completed']);
    // The dead session's token is not kept.
    expect(fs.readFileSync(storeFile('cc-closed'), 'utf8')).not.toContain('"tok-1"');
  });
});

describe('the record that replaces one the server closed', () => {
  it('counts only its own events and starts its own age', async () => {
    const T0 = Date.parse('2026-09-26T10:00:00Z');
    const MIN = 60_000;
    const lead = { session_id: 'cc-replaced', cwd: dir };
    await fire({ ...lead, hook_event_name: 'SessionStart' }, { now: T0 });
    await fire({ ...lead, hook_event_name: 'UserPromptSubmit' }, { now: T0 + 50 * MIN });
    await fire({ ...lead, hook_event_name: 'Stop' }, { now: T0 + 100 * MIN });
    await fire({ ...lead, hook_event_name: 'UserPromptSubmit' }, { now: T0 + 150 * MIN });
    api.terminate([...api.sessions.keys()][0]!);
    await fire({ ...lead, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, { now: T0 + 200 * MIN });
    // Past four hours since the first record began, but not since this one did.
    await fire({ ...lead, hook_event_name: 'Stop' }, { now: T0 + 245 * MIN });
    expect(api.completes()).toHaveLength(0);
    await fire({ ...lead, hook_event_name: 'SessionEnd', reason: 'other' }, { now: T0 + 246 * MIN });
    const second = [...api.sessions.values()][1]!;
    const reports = second.events.filter((e) => e.event_type === 'collector.report');
    const closing = reports[reports.length - 1]!;
    expect(closing.payload['phase']).toBe('session_end');
    expect(closing.payload['events_emitted']).toBe(second.events.length);
  });
});

describe('what the record says about itself', () => {
  it('every lifecycle report carries events_registered, so the last one does too', async () => {
    const proj = path.join(dir, 'proj');
    fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
    const hooks: Record<string, unknown> = {};
    for (const ev of ['SessionStart', 'PreToolUse', 'Stop', 'SessionEnd']) {
      hooks[ev] = [{ matcher: '*', hooks: [{ type: 'command', command: 'aer-hook --harness claude-code --lifecycle v2' }] }];
    }
    fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify({ hooks }));
    const lead = { session_id: 'cc-reg', cwd: proj };
    await fire({ ...lead, hook_event_name: 'SessionStart' });
    await fire({ ...lead, hook_event_name: 'Stop' });
    await fire({ ...lead, hook_event_name: 'SessionEnd' });
    const reports = api.eventsOf('collector.report');
    expect(reports.map((r) => r.payload['phase'])).toEqual(['session_start', 'turn_end', 'session_end']);
    for (const r of reports) expect(r.payload['events_registered']).toEqual(['PreToolUse', 'SessionEnd', 'SessionStart', 'Stop']);
  });

  it('carries the drop counters on every report, not only the closing one', async () => {
    // A subagent event with no lead yet is dropped and counted.
    await fire({ session_id: 'cc-drop', cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: {}, agent_id: 'early' });
    await fire({ session_id: 'cc-drop', cwd: dir, hook_event_name: 'SessionStart' });
    await fire({ session_id: 'cc-drop', cwd: dir, hook_event_name: 'Stop' });
    const reports = api.eventsOf('collector.report');
    expect(reports.map((r) => r.payload['subagent_events_unattached'])).toEqual([1, 1]);
  });
});

describe('a long interactive session', () => {
  const T0 = Date.parse('2026-09-26T10:00:00Z');
  const MIN = 60_000;

  it('completes its record at the first turn end once it is four hours old and goes on in a new one', async () => {
    const lead = { session_id: 'cc-long', cwd: dir };
    await fire({ ...lead, hook_event_name: 'SessionStart' }, { now: T0 });
    // Busy all afternoon: never quiet for an hour, and not yet four hours old.
    for (const at of [50, 100, 150, 200]) {
      await fire({ ...lead, hook_event_name: at % 100 === 0 ? 'UserPromptSubmit' : 'Stop' }, { now: T0 + at * MIN });
    }
    await fire({ ...lead, hook_event_name: 'Stop' }, { now: T0 + 230 * MIN });
    expect(api.completes()).toHaveLength(0);
    await fire({ ...lead, hook_event_name: 'UserPromptSubmit' }, { now: T0 + 235 * MIN });
    await fire({ ...lead, hook_event_name: 'Stop' }, { now: T0 + 241 * MIN });
    expect(api.completes()).toHaveLength(1);
    await fire({ ...lead, hook_event_name: 'UserPromptSubmit' }, { now: T0 + 242 * MIN });
    expect(api.sessions.size).toBe(2);
    const [a, b] = [...api.sessions.values()];
    expect(a!.status).toBe('completed');
    expect(b!.clientRef).toBe(a!.clientRef);
    expect(b!.events.map((e) => e.payload['phase'])).toEqual(['turn_start']);
    // Numbering carries on across records, so a reader can join them.
    expect(b!.events[0]!.payload['seq']).toBe(a!.events.length + 1);
  });

  it('takes the age from AER_HOOK_CHECKPOINT_MINUTES', async () => {
    const e = env({ AER_HOOK_CHECKPOINT_MINUTES: '30' });
    const lead = { session_id: 'cc-age30', cwd: dir };
    await fire({ ...lead, hook_event_name: 'SessionStart' }, { now: T0, env: e });
    await fire({ ...lead, hook_event_name: 'Stop' }, { now: T0 + 31 * MIN, env: e });
    expect(api.completes()).toHaveLength(1);
  });

  it('completes the previous record first when the harness comes back after a quiet period', async () => {
    const lead = { session_id: 'cc-idle', cwd: dir };
    await fire({ ...lead, hook_event_name: 'SessionStart' }, { now: T0 });
    await fire({ ...lead, hook_event_name: 'Stop' }, { now: T0 + 5 * MIN });
    await fire({ ...lead, hook_event_name: 'UserPromptSubmit' }, { now: T0 + 5 * MIN + 61 * MIN });
    expect(api.completes()).toHaveLength(1);
    const [a, b] = [...api.sessions.values()];
    expect(a!.events.map((e) => e.payload['phase'])).toEqual(['session_start', 'turn_end']);
    expect(b!.events.map((e) => e.payload['phase'])).toEqual(['turn_start']);
  });

  it('a session end right after a checkpoint opens no one-event record', async () => {
    const e = env({ AER_HOOK_CHECKPOINT_MINUTES: '30' });
    const lead = { session_id: 'cc-end-after-ck', cwd: dir };
    await fire({ ...lead, hook_event_name: 'SessionStart' }, { now: T0, env: e });
    await fire({ ...lead, hook_event_name: 'Stop' }, { now: T0 + 31 * MIN, env: e });
    await fire({ ...lead, hook_event_name: 'SessionEnd', reason: 'other' }, { now: T0 + 31 * MIN + 1000, env: e });
    expect(api.opens()).toHaveLength(1);
    expect(api.completes()).toHaveLength(1);
    expect(api.sessions.size).toBe(1);
    // The session is over: a late subagent event does not reopen it either.
    await fire({ ...lead, hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: {}, agent_id: 'late' }, { now: T0 + 32 * MIN, env: e });
    expect(api.opens()).toHaveLength(1);
  });

  it('a session end after a quiet period closes the record it ends, not a new one', async () => {
    const lead = { session_id: 'cc-end-after-quiet', cwd: dir };
    await fire({ ...lead, hook_event_name: 'SessionStart' }, { now: T0 });
    await fire({ ...lead, hook_event_name: 'Stop' }, { now: T0 + 5 * MIN });
    await fire({ ...lead, hook_event_name: 'SessionEnd', reason: 'other' }, { now: T0 + 70 * MIN });
    expect(api.sessions.size).toBe(1);
    expect(api.completes()).toHaveLength(1);
    const [a] = [...api.sessions.values()];
    expect(a!.events.map((x) => x.payload['phase'])).toEqual(['session_start', 'turn_end', 'session_end']);
  });

  it('takes the quiet period from AER_HOOK_QUIET_MINUTES', async () => {
    const e = env({ AER_HOOK_QUIET_MINUTES: '10' });
    const lead = { session_id: 'cc-quiet10', cwd: dir };
    await fire({ ...lead, hook_event_name: 'SessionStart' }, { now: T0, env: e });
    await fire({ ...lead, hook_event_name: 'UserPromptSubmit' }, { now: T0 + 11 * MIN, env: e });
    expect(api.completes()).toHaveLength(1);
  });

  it('keeps one record however long it runs when both are 0', async () => {
    const e = env({ AER_HOOK_CHECKPOINT_MINUTES: '0', AER_HOOK_QUIET_MINUTES: '0' });
    const lead = { session_id: 'cc-nock', cwd: dir };
    await fire({ ...lead, hook_event_name: 'SessionStart' }, { now: T0, env: e });
    await fire({ ...lead, hook_event_name: 'Stop' }, { now: T0 + 300 * MIN, env: e });
    await fire({ ...lead, hook_event_name: 'UserPromptSubmit' }, { now: T0 + 600 * MIN, env: e });
    expect(api.completes()).toHaveLength(0);
    expect(api.sessions.size).toBe(1);
  });
});

describe('a failed open', () => {
  it('queues the event, and the next event sends both without waiting', async () => {
    api.fault({ method: 'POST', path: /^\/v1\/sessions$/, status: 503, times: 2 });
    const lead = { session_id: 'cc-503', cwd: dir };
    await fire({ ...lead, hook_event_name: 'SessionStart' });
    expect(api.sessions.size).toBe(0);
    const t = Date.now();
    await fire({ ...lead, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(Date.now() - t).toBeLessThan(2000);
    expect(api.sessions.size).toBe(1);
    const s = [...api.sessions.values()][0]!;
    expect(s.events.map((e) => e.event_type)).toEqual(['collector.report', 'tool.started', 'process.exec']);
  });
});

describe('an unwritable cache', () => {
  it('falls back to a private directory and still records one session', async () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const e = env({ XDG_CACHE_HOME: blocker });
    const lead = { session_id: 'cc-nocache', cwd: dir };
    await fire({ ...lead, hook_event_name: 'SessionStart' }, { env: e });
    await fire({ ...lead, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, { env: e });
    await fire({ ...lead, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, tool_response: {} }, { env: e });
    expect(api.opens()).toHaveLength(1);
    expect(api.eventsOf('tool.started')).toHaveLength(1);
    expect(api.eventsOf('tool.completed')).toHaveLength(1);
    const fallback = fs.readdirSync(path.join(dir, 'tmp')).find((n) => n.startsWith('aer-hooks-'))!;
    expect(fallback).toBeDefined();
    expect(fs.statSync(path.join(dir, 'tmp', fallback)).mode & 0o077).toBe(0);
  });

  it('with nowhere to write, still records each event on the running session', async () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const e = env({ XDG_CACHE_HOME: blocker, TMPDIR: blocker, XDG_RUNTIME_DIR: blocker });
    const lead = { session_id: 'cc-nowhere', cwd: dir };
    await fire({ ...lead, hook_event_name: 'SessionStart' }, { env: e });
    await fire({ ...lead, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, { env: e });
    await fire({ ...lead, hook_event_name: 'SessionEnd' }, { env: e });
    expect(api.sessions.size).toBe(1);
    const s = [...api.sessions.values()][0]!;
    expect(s.events.map((x) => x.event_type)).toEqual(['collector.report', 'tool.started', 'process.exec', 'collector.report']);
    expect(s.status).toBe('completed');
  });
});

describe('an invocation cut off by its budget', () => {
  it('leaves what it queued for the next event, which sends it to the same session', async () => {
    api.eventsDelayMs = 5000;
    const lead = { session_id: 'cc-cut', cwd: dir };
    await main(V2, env(), { readInput: async () => JSON.stringify({ ...lead, hook_event_name: 'SessionStart' }), fetch: api.fetch, hardTimeoutMs: 1500 });
    await sleep(1500);
    api.eventsDelayMs = 0;
    await fire({ ...lead, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(api.sessions.size).toBe(1);
    const s = [...api.sessions.values()][0]!;
    expect(s.events.map((x) => x.event_type)).toEqual(['collector.report', 'tool.started', 'process.exec']);
  });

  it('reuses an open whose answer never arrived, rather than leaving it empty', async () => {
    api.openDelayMs = 5000;
    const lead = { session_id: 'cc-lost', cwd: dir };
    await main(V2, env(), { readInput: async () => JSON.stringify({ ...lead, hook_event_name: 'SessionStart' }), fetch: api.fetch, hardTimeoutMs: 1500 });
    await sleep(1500);
    api.openDelayMs = 0;
    await fire({ ...lead, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(api.sessions.size).toBe(1);
    const s = [...api.sessions.values()][0]!;
    expect(s.events.map((x) => x.event_type)).toEqual(['collector.report', 'tool.started', 'process.exec']);
  });
});

describe('what the API requires to open a session', () => {
  it('sends an agent version even when AER_AGENT_VERSION is unset', async () => {
    await fire({ session_id: 'cc-ver', cwd: dir, hook_event_name: 'SessionStart' });
    expect(api.sessions.size).toBe(1);
    expect(api.opens()[0]!.body).toMatchObject({ agent_version: 'unspecified' });
  });

  it('keeps AER_AGENT_VERSION when it is set', async () => {
    await fire({ session_id: 'cc-ver2', cwd: dir, hook_event_name: 'SessionStart' }, { env: env({ AER_AGENT_VERSION: '2.1.281' }) });
    expect(api.opens()[0]!.body).toMatchObject({ agent_version: '2.1.281' });
  });

  it('without AER_ENV_ID, says so once and sends nothing rather than queuing what can never open', async () => {
    const e = env();
    delete e['AER_ENV_ID'];
    const lines: string[] = [];
    await runHook(V2, e, { readInput: async () => JSON.stringify({ session_id: 'cc-noenv', cwd: dir, hook_event_name: 'SessionStart' }), fetch: api.fetch, logError: (m) => lines.push(m) });
    expect(api.requests).toHaveLength(0);
    expect(lines).toEqual([expect.stringMatching(/AER_ENV_ID/)]);
  });
});

describe('state left behind', () => {
  it('a session start clears what sessions that never came back left in the cache', async () => {
    fs.mkdirSync(path.join(cache, 'aer-hooks'), { recursive: true });
    const stale = path.join(cache, 'aer-hooks', `${'a'.repeat(32)}.json`);
    const drop = path.join(cache, 'aer-hooks', 'drop-orphan.json');
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    for (const p of [stale, drop]) {
      fs.writeFileSync(p, '{}');
      fs.utimesSync(p, old, old);
    }
    await fire({ session_id: 'cc-sweep', cwd: dir, hook_event_name: 'SessionStart' });
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(drop)).toBe(false);
    expect(fs.existsSync(storeFile('cc-sweep'))).toBe(true);
  });
});

describe('the end of a session the harness will not wait for', () => {
  it('hands the record to a worker and returns within the harness budget, and the worker completes it', async () => {
    const lead = { session_id: 'cc-headless', cwd: dir };
    await fire({ ...lead, hook_event_name: 'SessionStart' });
    api.openDelayMs = 0;
    api.eventsDelayMs = 3000;
    api.completeDelayMs = 3000;
    const handed: string[][] = [];
    const t = Date.now();
    await runHook(V2, env(), {
      readInput: async () => JSON.stringify({ ...lead, hook_event_name: 'SessionEnd', reason: 'other' }),
      fetch: api.fetch,
      handOff: (argv) => { handed.push(argv); return true; },
    });
    // Claude Code gives SessionEnd hooks 1.5 s unless configured otherwise.
    expect(Date.now() - t).toBeLessThan(1500);
    expect(api.completes()).toHaveLength(0);
    expect(handed).toHaveLength(1);
    expect(handed[0]).toContain('--drain=cc-headless');
    expect(JSON.stringify(handed[0])).not.toMatch(/tok-|AER_API_KEY|"k"/);

    api.eventsDelayMs = 0;
    api.completeDelayMs = 0;
    await runDrain(handed[0]!, env(), { fetch: api.fetch });
    expect(api.completes()).toHaveLength(1);
    const s = [...api.sessions.values()][0]!;
    expect(s.status).toBe('completed');
    expect(s.events.map((e) => e.payload['phase'])).toEqual(['session_start', 'session_end']);
  });

  it('counts the inline window from process start, and sends nothing when too little of it is left', async () => {
    const lead = { session_id: 'cc-late-end', cwd: dir };
    await fire({ ...lead, hook_event_name: 'SessionStart' });
    const before = api.requests.length;
    const handed: string[][] = [];
    const t = Date.now();
    await runHook(V2, env(), {
      readInput: async () => JSON.stringify({ ...lead, hook_event_name: 'SessionEnd', reason: 'other' }),
      fetch: api.fetch,
      handOff: (argv) => { handed.push(argv); return true; },
      // Node startup, stdin and the config reads already took a second.
      processStart: Date.now() - 1000,
    });
    expect(Date.now() - t).toBeLessThan(400);
    expect(api.requests.length).toBe(before);
    expect(handed).toHaveLength(1);
  });

  it('completes inline when the API answers quickly, and the worker then finds nothing to do', async () => {
    const lead = { session_id: 'cc-fast-end', cwd: dir };
    await fire({ ...lead, hook_event_name: 'SessionStart' });
    const handed: string[][] = [];
    await runHook(V2, env(), {
      readInput: async () => JSON.stringify({ ...lead, hook_event_name: 'SessionEnd', reason: 'other' }),
      fetch: api.fetch,
      handOff: (argv) => { handed.push(argv); return true; },
    });
    expect(api.completes()).toHaveLength(1);
    await runDrain(handed[0]!, env(), { fetch: api.fetch });
    expect(api.completes()).toHaveLength(1);
    expect(api.opens()).toHaveLength(1);
  });

  it('a worker that cannot be started leaves the hook to deliver inline with its full budget', async () => {
    const lead = { session_id: 'cc-no-worker', cwd: dir };
    await fire({ ...lead, hook_event_name: 'SessionStart' });
    api.completeDelayMs = 1500;
    await runHook(V2, env(), {
      readInput: async () => JSON.stringify({ ...lead, hook_event_name: 'SessionEnd', reason: 'other' }),
      fetch: api.fetch,
      handOff: () => false,
    });
    expect(api.completes()).toHaveLength(1);
  });
});

describe('the worker when the API never answers', () => {
  const neverAnswers = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    await new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    throw new Error('unreachable');
  }) as typeof fetch;

  async function endedWithQueue(sid: string): Promise<string[]> {
    await fire({ session_id: sid, cwd: dir, hook_event_name: 'SessionStart' });
    const handed: string[][] = [];
    api.eventsDelayMs = 60_000;
    await runHook(V2, env(), {
      readInput: async () => JSON.stringify({ session_id: sid, cwd: dir, hook_event_name: 'SessionEnd', reason: 'other' }),
      fetch: api.fetch,
      handOff: (argv) => { handed.push(argv); return true; },
      logError: () => undefined,
    });
    api.eventsDelayMs = 0;
    return handed[0]!;
  }

  it('keeps the closing report queued however many times no answer comes', async () => {
    const argv = await endedWithQueue('cc-never');
    // The probe: several workers in turn, each spending its whole budget on an API that never answers.
    for (let i = 0; i < 6; i++) await runDrain(argv, env(), { fetch: neverAnswers, drainBudgetMs: 2500, logError: () => undefined });
    const st = loadState('cc-never', env())!;
    expect(st.complete).toBe('end');
    expect(st.outbox.map((e) => e.payload['phase'])).toEqual(['session_end']);
    expect(st.droppedBudget).toBe(0);
    // When the API comes back, the next worker completes the record.
    await runDrain(argv, env(), { fetch: api.fetch });
    expect(api.completes()).toHaveLength(1);
  }, 60_000);

  it('never drops the closing report to the send-attempt cap, even on repeated refusals', async () => {
    const argv = await endedWithQueue('cc-refused');
    const refuses = (async () => new Response('{}', { status: 503 })) as typeof fetch;
    for (let i = 0; i < 8; i++) await runDrain(argv, env(), { fetch: refuses, drainBudgetMs: 2500, logError: () => undefined });
    const st = loadState('cc-refused', env())!;
    expect(st.outbox.map((e) => e.payload['phase'])).toEqual(['session_end']);
    await runDrain(argv, env(), { fetch: api.fetch });
    expect(api.completes()).toHaveLength(1);
  }, 60_000);
});

describe('what the worker is told', () => {
  async function handedFor(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<string[]> {
    const lead = { session_id: `cc-args-${args.length}`, cwd: dir };
    const e = env(extraEnv);
    await runHook([...V2, ...args], e, { readInput: async () => JSON.stringify({ ...lead, hook_event_name: 'SessionStart' }), fetch: api.fetch });
    const handed: string[][] = [];
    await runHook([...V2, ...args], e, {
      readInput: async () => JSON.stringify({ ...lead, hook_event_name: 'SessionEnd', reason: 'other' }),
      fetch: api.fetch,
      handOff: (argv) => { handed.push(argv); return true; },
    });
    return handed[0]!;
  }

  it('gets only the flags it reads: the credential file and which session to finish, for which harness', async () => {
    const argv = await handedFor(['--root-session', 'root-x', '--event', 'Stop']);
    expect(argv.filter((a) => a.startsWith('--')).map((a) => a.split('=')[0])).toEqual(['--drain', '--drain-harness', '--harness-pid']);
  });

  it('gets a session id that looks like a flag as data, never as a flag', async () => {
    const sid = '--env-file=/tmp/not-a-credential-file';
    const lead = { session_id: sid, cwd: dir };
    await runHook(V2, env(), { readInput: async () => JSON.stringify({ ...lead, hook_event_name: 'SessionStart' }), fetch: api.fetch });
    const handed: string[][] = [];
    api.eventsDelayMs = 60_000;
    await runHook(V2, env(), {
      readInput: async () => JSON.stringify({ ...lead, hook_event_name: 'SessionEnd', reason: 'other' }),
      fetch: api.fetch,
      handOff: (argv) => { handed.push(argv); return true; },
    });
    api.eventsDelayMs = 0;
    const argv = handed[0]!;
    expect(argv.filter((a) => a.startsWith('--env-file'))).toEqual([]);
    expect(argv).toContain(`--drain=${sid}`);
    await runDrain(argv, env(), { fetch: api.fetch });
    expect(api.completes()).toHaveLength(1);
  });

  it('gets the credential file as an absolute path, so it does not depend on a directory that may be gone', async () => {
    const file = path.join(dir, 'hooks.env');
    fs.writeFileSync(file, 'AER_TENANT_ID=t\n', { mode: 0o600 });
    const rel = path.relative(process.cwd(), file);
    const argv = await handedFor(['--env-file', rel]);
    expect(argv[argv.indexOf('--env-file') + 1]).toBe(file);
  });
});

describe('what the worker writes down', () => {
  it('says the record stays open, never that a later event will send it', async () => {
    const sid = 'cc-worker-words';
    await fire({ session_id: sid, cwd: dir, hook_event_name: 'SessionStart' });
    const handed: string[][] = [];
    api.eventsDelayMs = 60_000;
    await runHook(V2, env(), {
      readInput: async () => JSON.stringify({ session_id: sid, cwd: dir, hook_event_name: 'SessionEnd', reason: 'other' }),
      fetch: api.fetch,
      handOff: (argv) => { handed.push(argv); return true; },
      logError: () => undefined,
    });
    const lines: string[] = [];
    const refuses = (async () => new Response('{}', { status: 503 })) as typeof fetch;
    await runDrain(handed[0]!, env(), { fetch: refuses, drainBudgetMs: 2500, logError: (m) => lines.push(m) });
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l).not.toMatch(/later event/);
      expect(l).toMatch(/the record stays open/);
    }
  });

  it('the hook stays quiet about an inline send the worker is taking over', async () => {
    const sid = 'cc-quiet-handoff';
    await fire({ session_id: sid, cwd: dir, hook_event_name: 'SessionStart' });
    api.eventsDelayMs = 60_000;
    const lines: string[] = [];
    await runHook(V2, env(), {
      readInput: async () => JSON.stringify({ session_id: sid, cwd: dir, hook_event_name: 'SessionEnd', reason: 'other' }),
      fetch: api.fetch,
      handOff: () => true,
      logError: (m) => lines.push(m),
    });
    expect(lines).toEqual([]);
  });

});

describe('a batch that never gets an answer', () => {
  it('is split, so a queue that only large requests fail on still drains', async () => {
    const sid = 'cc-split';
    await fire({ session_id: sid, cwd: dir, hook_event_name: 'SessionStart' });
    // An API that answers one event at once but never answers a batch.
    const onlySingles = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/events') && (JSON.parse(String(init?.body)) as unknown[]).length > 1) {
        await new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      }
      return api.fetch(input, init);
    }) as typeof fetch;
    for (let i = 0; i < 5; i++) {
      await runHook(V2, env(), {
        readInput: async () => JSON.stringify({ session_id: sid, cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: `/f${i}` } }),
        fetch: onlySingles,
        hardTimeoutMs: 1500,
        logError: () => undefined,
      });
    }
    const drain = [`--drain=${sid}`, '--drain-harness=claude-code', '--harness-pid=1'];
    for (let i = 0; i < 4 && (loadState(sid, env())?.outbox.length ?? 0) > 0; i++) {
      await runDrain(drain, env(), { fetch: onlySingles, drainBudgetMs: 3000, logError: () => undefined });
    }
    expect(loadState(sid, env())?.outbox).toEqual([]);
    expect(api.eventsOf('tool.started')).toHaveLength(5);
    expect(api.eventsOf('file.opened')).toHaveLength(5);
  }, 60_000);
});
