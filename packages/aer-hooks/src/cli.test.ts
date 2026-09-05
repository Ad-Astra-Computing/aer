import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runHook, main, parseHardTimeoutMs } from './cli.js';

const CONFIGURED = {
  AER_API_KEY: 'k',
  AER_TENANT_ID: 't',
  AER_AGENT_ID: 'a',
  AER_BASE_URL: 'https://api.test',
} as NodeJS.ProcessEnv;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// runHook uses the process-global fetch inside aer-emit's sink. Stub it per test.
function stubFetch() {
  const calls: string[] = [];
  const fake = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/v1/sessions')) return jsonResponse({ id: 's1', ingest_token: 'tok' });
    return jsonResponse({ ok: true });
  });
  vi.stubGlobal('fetch', fake);
  return { calls };
}

describe('aer-hook fail-open behavior', () => {
  it('unconfigured: does nothing and touches no network', async () => {
    const { calls } = stubFetch();
    await expect(
      runHook(['--harness', 'claude-code'], {}, { readInput: async () => '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"x"}}' }),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('garbage stdin: resolves (exit 0) and never rejects', async () => {
    stubFetch();
    await expect(
      runHook(['--harness', 'claude-code'], CONFIGURED, { readInput: async () => 'not json {{{' }),
    ).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('empty stdin: resolves without emitting events', async () => {
    const { calls } = stubFetch();
    await expect(
      runHook(['--harness', 'claude-code'], CONFIGURED, { readInput: async () => '   ' }),
    ).resolves.toBeUndefined();
    // no session opened because nothing was emitted (idle producer stays off-network)
    expect(calls).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('valid payload: opens a session and posts a tool event', async () => {
    const { calls } = stubFetch();
    await runHook(['--harness', 'claude-code'], CONFIGURED, {
      readInput: async () =>
        JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
        }),
    });
    expect(calls.some((u) => u.endsWith('/v1/sessions'))).toBe(true);
    expect(calls.some((u) => u.endsWith('/events'))).toBe(true);
    expect(calls.some((u) => u.endsWith('/complete'))).toBe(true);
    vi.unstubAllGlobals();
  });

  it('never rejects even if fetch throws for a valid payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    await expect(
      runHook(['--harness', 'codex'], CONFIGURED, {
        readInput: async () =>
          JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, turn_id: 't' }),
      }),
    ).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('never writes to stdout', async () => {
    stubFetch();
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    await runHook(['--harness', 'claude-code'], CONFIGURED, {
      readInput: async () =>
        JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, tool_response: {} }),
    });
    spy.mockRestore();
    expect(writes.join('')).toBe('');
    vi.unstubAllGlobals();
  });
});

// The bug this guards against: a harness fires the hook once per event as a
// SEPARATE process, so without cross-process correlation every tool call would
// open its own AER session. These drive runHook repeatedly against a SHARED
// cache dir (via XDG_CACHE_HOME) and count opens/completes.
describe('aer-hook cross-invocation session correlation', () => {
  let cacheDir: string;
  let openIds: string[];
  let opens: number;
  let completes: number;
  let eventSessionIds: string[];
  let fetchImpl: typeof fetch;

  const cc = (o: Record<string, unknown>): string => JSON.stringify(o);

  function envWith(): NodeJS.ProcessEnv {
    return { ...CONFIGURED, XDG_CACHE_HOME: cacheDir } as NodeJS.ProcessEnv;
  }
  function fire(payload: Record<string, unknown>): Promise<void> {
    return runHook(['--harness', 'claude-code'], envWith(), {
      readInput: async () => cc(payload),
      fetch: fetchImpl,
    });
  }

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aer-hooks-test-'));
    openIds = [];
    opens = 0;
    completes = 0;
    eventSessionIds = [];
    fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/sessions')) {
        opens += 1;
        const id = `sess-${opens}`;
        openIds.push(id);
        return jsonResponse({ id, ingest_token: `tok-${opens}` });
      }
      if (url.endsWith('/complete')) {
        completes += 1;
        return jsonResponse({ ok: true });
      }
      const m = /\/v1\/sessions\/([^/]+)\/events$/.exec(url);
      if (m) eventSessionIds.push(m[1]!);
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('SessionStart, 3 tool pairs, Stop => exactly ONE open and ONE complete', async () => {
    const sid = 'harness-session-1';
    await fire({ hook_event_name: 'SessionStart', session_id: sid });
    for (let i = 0; i < 3; i++) {
      await fire({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `c${i}` }, session_id: sid });
      await fire({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, tool_response: {}, session_id: sid });
    }
    await fire({ hook_event_name: 'Stop', session_id: sid });

    expect(opens).toBe(1);
    expect(completes).toBe(1);
    // Every emitted event went to the one opened session.
    expect(eventSessionIds.length).toBeGreaterThan(0);
    expect(new Set(eventSessionIds)).toEqual(new Set(['sess-1']));
  });

  it('a tool event with no prior SessionStart opens once and is reused', async () => {
    const sid = 'harness-session-2';
    await fire({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, session_id: sid });
    await fire({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, tool_response: {}, session_id: sid });
    expect(opens).toBe(1);
    expect(completes).toBe(0); // no Stop yet, session stays open
    expect(new Set(eventSessionIds)).toEqual(new Set(['sess-1']));
  });

  it('two different harness sessions get two different AER sessions', async () => {
    await fire({ hook_event_name: 'SessionStart', session_id: 'hs-A' });
    await fire({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, session_id: 'hs-A' });
    await fire({ hook_event_name: 'SessionStart', session_id: 'hs-B' });
    await fire({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, session_id: 'hs-B' });
    expect(opens).toBe(2);
    expect(new Set(eventSessionIds)).toEqual(new Set(['sess-1', 'sess-2']));
  });

  it('store failure (unwritable cache dir) still emits and never throws', async () => {
    // Point the store at a path UNDER a regular file, so every mkdir/read/write
    // fails with ENOTDIR. cacheDir (the real temp dir) is left for afterEach.
    const blocker = path.join(cacheDir, 'blocker-file');
    fs.writeFileSync(blocker, 'x');
    const badEnv = { ...CONFIGURED, XDG_CACHE_HOME: path.join(blocker, 'nope') } as NodeJS.ProcessEnv;
    await expect(
      runHook(['--harness', 'claude-code'], badEnv, {
        readInput: async () => cc({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, session_id: 'hs-x' }),
        fetch: fetchImpl,
      }),
    ).resolves.toBeUndefined();
    // Degrades to opening a session; the point is it did not throw.
    expect(opens).toBeGreaterThanOrEqual(1);
  });

  // The TOCTOU bug this guards against: two hook processes for the SAME harness
  // session, launched together, both see no stored session and each open their
  // own upstream AER session, orphaning one. A slow (delayed) fetch widens the
  // race window the way a real network round trip does.
  it('two concurrent hooks for the same harness session converge on one AER session', async () => {
    const sid = 'harness-session-concurrent';
    const slowFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/sessions')) {
        await new Promise((r) => setTimeout(r, 15));
        opens += 1;
        const id = `sess-${opens}`;
        openIds.push(id);
        return jsonResponse({ id, ingest_token: `tok-${opens}` });
      }
      if (url.endsWith('/complete')) {
        completes += 1;
        return jsonResponse({ ok: true });
      }
      const m = /\/v1\/sessions\/([^/]+)\/events$/.exec(url);
      if (m) eventSessionIds.push(m[1]!);
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    await Promise.all([
      runHook(['--harness', 'claude-code'], envWith(), {
        readInput: async () => cc({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'a' }, session_id: sid }),
        fetch: slowFetch,
      }),
      runHook(['--harness', 'claude-code'], envWith(), {
        readInput: async () =>
          cc({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'b' }, session_id: sid }),
        fetch: slowFetch,
      }),
    ]);

    expect(opens).toBe(1);
    expect(new Set(eventSessionIds)).toEqual(new Set(['sess-1']));
  });
});

describe('parseHardTimeoutMs', () => {
  it('returns undefined (use the default) when unset', () => {
    const warn = vi.fn();
    expect(parseHardTimeoutMs({}, warn)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts a positive integer string', () => {
    const warn = vi.fn();
    expect(parseHardTimeoutMs({ AER_HOOK_TIMEOUT_MS: '15000' }, warn)).toBe(15000);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', '1.5', 'nope', ''])('falls back and warns once on an invalid value %p', (raw) => {
    const warn = vi.fn();
    expect(parseHardTimeoutMs({ AER_HOOK_TIMEOUT_MS: raw }, warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

// Production session creation measures 3-4s; the hard timeout must give that
// room while still guaranteeing the hook never blocks the harness's tool.
describe('main() hard-timeout budget', () => {
  it('never blocks: exits the race and writes one stderr diagnostic when runHook exceeds the budget', async () => {
    const stderrWrites: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    const neverResolvingFetch = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const started = Date.now();
    await main(['--harness', 'claude-code'], { ...CONFIGURED, AER_HOOK_TIMEOUT_MS: '30' }, {
      readInput: async () => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }),
      fetch: neverResolvingFetch,
    });
    const elapsed = Date.now() - started;

    spy.mockRestore();
    expect(elapsed).toBeLessThan(1000); // bounded by the 30ms override, not left hanging
    expect(stderrWrites.join('')).toMatch(/timed out|timeout/i);
    expect(stderrWrites.join('')).not.toMatch(/bearer|ingest[-_]?token/i);
  });

  it('does not log a timeout diagnostic when runHook completes within the budget', async () => {
    const stderrWrites: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    const fastFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/sessions')) return jsonResponse({ id: 's1', ingest_token: 'tok' });
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    await main(['--harness', 'claude-code'], CONFIGURED, {
      readInput: async () => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }),
      fetch: fastFetch,
    });

    spy.mockRestore();
    expect(stderrWrites.join('')).toBe('');
  });
});
