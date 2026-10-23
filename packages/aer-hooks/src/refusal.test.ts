// The AER API's two structured 403 refusal bodies (usage cap reached, agent
// paused) must never be treated as "the session is gone": that path drops the
// session and reopens with the same client_ref, which would hammer the API
// on every later hook invocation while the tenant is over its cap or the
// agent is paused. Instead the hook backs off for recheck_after_seconds,
// keeps the queued events, and surfaces one clear message.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runHook } from './cli.js';
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
    HOME: path.join(dir, 'home'),
    ...extra,
  } as NodeJS.ProcessEnv;
}

function fire(payload: Record<string, unknown>, opts: { now?: number; logError?: (m: string) => void } = {}): Promise<void> {
  return runHook(V2, env(), {
    readInput: async () => JSON.stringify(payload),
    fetch: api.fetch,
    logError: opts.logError ?? (() => undefined),
    ...(opts.now !== undefined ? { now: () => opts.now! } : {}),
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aer-refusal-'));
  cache = path.join(dir, 'cache');
  fs.mkdirSync(path.join(dir, 'tmp'));
  api = new FakeApi();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a usage_limit_reached refusal on events', () => {
  it('backs off instead of reopening the session, and surfaces a clear message', async () => {
    const T0 = Date.parse('2026-10-21T10:00:00Z');
    const lead = { session_id: 'cc-usage-cap', cwd: dir };
    await fire({ ...lead, hook_event_name: 'SessionStart' }, { now: T0 });
    expect(api.sessions.size).toBe(1);

    api.fault({
      path: /\/events$/,
      status: 403,
      body: {
        error: 'usage_limit_reached', unit: 'events', scope: 'hard', limit: 125000, used: 125000,
        period_end: '2026-10-31T23:59:59.999Z', recheck_after_seconds: 3600,
        upgrade_url: 'https://aer.run/settings#usage',
      },
    });

    const lines: string[] = [];
    await fire(
      { ...lead, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
      { now: T0 + 1000, logError: (m) => lines.push(m) },
    );

    // Never treated as the session being gone: no second session opened.
    expect(api.sessions.size).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('{');
    expect(lines[0]).toMatch(/usage cap/i);
    expect(lines[0]).toContain('https://aer.run/settings#usage');
  });

  it('does not retry (no further network calls) while the cooldown is in effect', async () => {
    const T0 = Date.parse('2026-10-21T10:00:00Z');
    const lead = { session_id: 'cc-usage-cap-2', cwd: dir };
    await fire({ ...lead, hook_event_name: 'SessionStart' }, { now: T0 });

    api.fault({
      path: /\/events$/,
      status: 403,
      body: { error: 'usage_limit_reached', unit: 'events', recheck_after_seconds: 3600 },
    });
    await fire({ ...lead, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'a' } }, { now: T0 + 1000 });
    const requestsAfterRefusal = api.requests.length;

    const lines: string[] = [];
    await fire(
      { ...lead, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'a' }, tool_response: {} },
      { now: T0 + 2000, logError: (m) => lines.push(m) },
    );

    expect(api.requests.length).toBe(requestsAfterRefusal); // no new HTTP calls at all
    expect(lines).toHaveLength(0); // no second warning for the same episode
  });

  it('clamps an out-of-range recheck_after_seconds rather than trusting it verbatim', async () => {
    const T0 = Date.parse('2026-10-21T10:00:00Z');
    const lead = { session_id: 'cc-usage-cap-clamp', cwd: dir };
    await fire({ ...lead, hook_event_name: 'SessionStart' }, { now: T0 });

    api.fault({
      path: /\/events$/,
      status: 403,
      // 0 would otherwise remove the backoff entirely, retrying on every call.
      body: { error: 'usage_limit_reached', unit: 'events', recheck_after_seconds: 0 },
    });
    await fire({ ...lead, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'a' } }, { now: T0 + 1000 });

    const st = loadState('cc-usage-cap-clamp', env(), T0 + 2000)!;
    // Clamped up to 1s, not 0 (which would otherwise remove the backoff
    // entirely); allow a tiny margin for the harness's own clock reads.
    expect(st.refusedUntil).toBeGreaterThanOrEqual(T0 + 1000 + 1000);
    expect(st.refusedUntil).toBeLessThan(T0 + 1000 + 1000 + 50);
  });

  it('resumes and sends queued events once the cooldown elapses', async () => {
    const T0 = Date.parse('2026-10-21T10:00:00Z');
    const lead = { session_id: 'cc-usage-cap-3', cwd: dir };
    await fire({ ...lead, hook_event_name: 'SessionStart' }, { now: T0 });

    api.fault({
      path: /\/events$/, status: 403, times: 1,
      body: { error: 'usage_limit_reached', unit: 'events', recheck_after_seconds: 60 },
    });
    await fire({ ...lead, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'a' } }, { now: T0 + 1000 });
    expect(api.eventsOf('tool.started')).toHaveLength(0);

    await fire(
      { ...lead, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'a' }, tool_response: {} },
      { now: T0 + 65_000 },
    );
    expect(api.eventsOf('tool.started').length).toBeGreaterThan(0);
  });
});

describe('an agent_paused refusal on session open', () => {
  it('backs off instead of the ordinary open-retry backoff, with a clear message', async () => {
    const T0 = Date.parse('2026-10-21T10:00:00Z');
    api.fault({
      path: /^\/v1\/sessions$/, status: 403,
      body: { error: 'agent_paused', agent_id: 'agt_1', recheck_after_seconds: 120 },
    });
    const lines: string[] = [];
    const lead = { session_id: 'cc-paused', cwd: dir };
    await fire({ ...lead, hook_event_name: 'SessionStart' }, { now: T0, logError: (m) => lines.push(m) });

    expect(api.sessions.size).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('{');
    expect(lines[0]).toMatch(/paused/i);

    // This is the refusal cooldown, not the ordinary open-retry backoff: no
    // openFailures/retryOpenAt bookkeeping, and no new request (or log line)
    // from a second event inside the 120s window.
    const st = loadState('cc-paused', env(), T0)!;
    expect(st.openFailures).toBeUndefined();
    expect(st.retryOpenAt).toBeUndefined();
    expect(st.refusedUntil).toBeGreaterThanOrEqual(T0 + 120_000);
    expect(st.refusedUntil).toBeLessThan(T0 + 120_000 + 50);

    const requestsAfterFirstRefusal = api.requests.length;
    await fire(
      { ...lead, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'a' } },
      { now: T0 + 1000, logError: (m) => lines.push(m) },
    );
    expect(api.requests.length).toBe(requestsAfterFirstRefusal); // no new HTTP calls at all
    expect(lines).toHaveLength(1); // no second warning for the same episode
  });
});

describe('an unrelated 403', () => {
  it('still falls back to the existing session-gone / drop behavior', async () => {
    const T0 = Date.parse('2026-10-21T10:00:00Z');
    const lead = { session_id: 'cc-unrelated-403', cwd: dir };
    await fire({ ...lead, hook_event_name: 'SessionStart' }, { now: T0 });
    api.fault({ path: /\/events$/, status: 403, body: { error: 'forbidden' } });
    await fire({ ...lead, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, { now: T0 + 1000 });
    // Treated as session-gone (unlike the two confirmed refusal shapes): the
    // client drops its view of the session and opens again with the same
    // client_ref, a second POST /v1/sessions, rather than backing off.
    expect(api.opens().length).toBeGreaterThan(1);
  });
});
