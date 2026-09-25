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

  it('store failure (unwritable cache dir) still resolves and never throws', async () => {
    // Point the store at a path UNDER a regular file, so every mkdir/read/write
    // fails with ENOTDIR. cacheDir (the real temp dir) is left for afterEach.
    const blocker = path.join(cacheDir, 'blocker-file');
    fs.writeFileSync(blocker, 'x');
    const badEnv = { ...CONFIGURED, XDG_CACHE_HOME: path.join(blocker, 'nope') } as NodeJS.ProcessEnv;
    // A tool event that cannot get the lock polls the (unwritable) store until
    // the budget's poll deadline, then drops rather than opens (ADR-023 B2). A
    // short hardTimeoutMs keeps that poll from taking the real 10s default.
    await expect(
      runHook(['--harness', 'claude-code'], badEnv, {
        readInput: async () => cc({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, session_id: 'hs-x' }),
        fetch: fetchImpl,
        hardTimeoutMs: 700,
      }),
    ).resolves.toBeUndefined();
    // Never opens on a lock-loss for a tool event; it did not throw either.
    expect(opens).toBe(0);
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

// The bug this section guards against: Claude Code sends no model on any hook
// payload, so every hooks-recorded session had tool.* events and no llm.*
// events at all. transcript_path is on every payload, and the transcript's
// assistant entries carry message.model / message.usage, so PostToolUse/Stop/
// SubagentStop/SessionEnd read it (bounded, incremental, bodies-off) and emit
// llm.completed alongside the tool events.
describe('aer-hook Claude Code transcript llm usage', () => {
  let cacheDir: string;
  let transcriptDir: string;
  let postedEvents: Array<{ event_type: string; payload: Record<string, unknown> }>;
  let fetchImpl: typeof fetch;

  function envWith(): NodeJS.ProcessEnv {
    return { ...CONFIGURED, XDG_CACHE_HOME: cacheDir } as NodeJS.ProcessEnv;
  }

  function assistantLine(id: string, uuid: string, model = 'claude-opus-4-8', inTok = 12, outTok = 340): string {
    return JSON.stringify({
      type: 'assistant',
      uuid,
      timestamp: '2026-09-01T00:00:00.000Z',
      message: {
        id,
        role: 'assistant',
        model,
        usage: { input_tokens: inTok, output_tokens: outTok },
        content: [{ type: 'text', text: 'SECRET-ASSISTANT-TEXT' }],
      },
    });
  }

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aer-hooks-transcript-'));
    transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aer-hooks-transcript-file-'));
    postedEvents = [];
    fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/sessions')) return jsonResponse({ id: 'sess-1', ingest_token: 'tok-1' });
      if (url.endsWith('/complete')) return jsonResponse({ ok: true });
      if (/\/v1\/sessions\/[^/]+\/events$/.test(url) && init?.body) {
        for (const e of JSON.parse(String(init.body)) as Array<Record<string, unknown>>) {
          postedEvents.push({ event_type: e['event_type'] as string, payload: e['payload'] as Record<string, unknown> });
        }
      }
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.rmSync(transcriptDir, { recursive: true, force: true });
  });

  it('PostToolUse with a transcript_path emits llm.completed with model + token counts', async () => {
    const transcriptPath = path.join(transcriptDir, 't.jsonl');
    fs.writeFileSync(transcriptPath, assistantLine('msg_1', 'a1') + '\n');
    const sid = 'harness-llm-1';

    await runHook(['--harness', 'claude-code'], envWith(), {
      fetch: fetchImpl,
      readInput: async () =>
        JSON.stringify({
          hook_event_name: 'PostToolUse', session_id: sid, transcript_path: transcriptPath,
          tool_name: 'Bash', tool_input: {}, tool_response: {},
        }),
    });

    const llm = postedEvents.find((e) => e.event_type === 'llm.completed');
    expect(llm).toBeDefined();
    expect(llm!.payload).toMatchObject({ model: 'claude-opus-4-8', provider: 'anthropic', input_tokens: 12, output_tokens: 340 });
  });

  it('never puts the transcript assistant text on the wire', async () => {
    const transcriptPath = path.join(transcriptDir, 't.jsonl');
    fs.writeFileSync(transcriptPath, assistantLine('msg_1', 'a1') + '\n');
    await runHook(['--harness', 'claude-code'], envWith(), {
      fetch: fetchImpl,
      readInput: async () =>
        JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'hs-y', transcript_path: transcriptPath, tool_name: 'Bash', tool_input: {}, tool_response: {} }),
    });
    expect(JSON.stringify(postedEvents)).not.toContain('SECRET-ASSISTANT-TEXT');
  });

  it('is incremental across invocations: the second only reports the newly appended turn', async () => {
    const transcriptPath = path.join(transcriptDir, 't.jsonl');
    const sid = 'harness-llm-2';
    fs.writeFileSync(transcriptPath, assistantLine('msg_1', 'a1') + '\n');
    await runHook(['--harness', 'claude-code'], envWith(), {
      fetch: fetchImpl,
      readInput: async () =>
        JSON.stringify({ hook_event_name: 'PostToolUse', session_id: sid, transcript_path: transcriptPath, tool_name: 'Bash', tool_input: {}, tool_response: {} }),
    });
    expect(postedEvents.filter((e) => e.event_type === 'llm.completed')).toHaveLength(1);

    fs.appendFileSync(transcriptPath, assistantLine('msg_2', 'a2', 'claude-opus-4-8', 1, 2) + '\n');
    postedEvents = [];
    await runHook(['--harness', 'claude-code'], envWith(), {
      fetch: fetchImpl,
      readInput: async () =>
        JSON.stringify({ hook_event_name: 'PostToolUse', session_id: sid, transcript_path: transcriptPath, tool_name: 'Bash', tool_input: {}, tool_response: {} }),
    });
    const second = postedEvents.filter((e) => e.event_type === 'llm.completed');
    expect(second).toHaveLength(1);
    expect(second[0]!.payload['output_tokens']).toBe(2);
  });

  it('does not re-emit on a re-run against the same unchanged transcript (session_end path)', async () => {
    const transcriptPath = path.join(transcriptDir, 't.jsonl');
    const sid = 'harness-llm-3';
    fs.writeFileSync(transcriptPath, assistantLine('msg_1', 'a1') + '\n');
    await runHook(['--harness', 'claude-code'], envWith(), {
      fetch: fetchImpl,
      readInput: async () =>
        JSON.stringify({ hook_event_name: 'PostToolUse', session_id: sid, transcript_path: transcriptPath, tool_name: 'Bash', tool_input: {}, tool_response: {} }),
    });
    postedEvents = [];
    await runHook(['--harness', 'claude-code'], envWith(), {
      fetch: fetchImpl,
      readInput: async () =>
        JSON.stringify({ hook_event_name: 'SessionEnd', session_id: sid, transcript_path: transcriptPath, reason: 'other' }),
    });
    expect(postedEvents.filter((e) => e.event_type === 'llm.completed')).toHaveLength(0);
  });

  it('a PreToolUse (not a settle point) never scans the transcript', async () => {
    const transcriptPath = path.join(transcriptDir, 't.jsonl');
    fs.writeFileSync(transcriptPath, assistantLine('msg_1', 'a1') + '\n');
    await runHook(['--harness', 'claude-code'], envWith(), {
      fetch: fetchImpl,
      readInput: async () =>
        JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'hs-z', transcript_path: transcriptPath, tool_name: 'Bash', tool_input: { command: 'ls' } }),
    });
    expect(postedEvents.some((e) => e.event_type === 'llm.completed')).toBe(false);
  });

  it('a missing transcript file is silent: no throw, no llm.completed, tool event still recorded', async () => {
    await expect(
      runHook(['--harness', 'claude-code'], envWith(), {
        fetch: fetchImpl,
        readInput: async () =>
          JSON.stringify({
            hook_event_name: 'PostToolUse', session_id: 'hs-missing', transcript_path: path.join(transcriptDir, 'gone.jsonl'),
            tool_name: 'Bash', tool_input: {}, tool_response: {},
          }),
      }),
    ).resolves.toBeUndefined();
    expect(postedEvents.some((e) => e.event_type === 'tool.completed')).toBe(true);
    expect(postedEvents.some((e) => e.event_type === 'llm.completed')).toBe(false);
  });

  // P2-2: with no session_id, every invocation is a fresh single-shot with no
  // persisted offset, so scanning would replay the whole transcript on each
  // call. Two calls against the same never-consumed transcript must not
  // double-report it.
  it('never scans the transcript on the no-session-id (!ref) single-shot path', async () => {
    const transcriptPath = path.join(transcriptDir, 't.jsonl');
    fs.writeFileSync(transcriptPath, assistantLine('msg_1', 'a1') + '\n');
    for (let i = 0; i < 2; i++) {
      await runHook(['--harness', 'claude-code'], envWith(), {
        fetch: fetchImpl,
        readInput: async () =>
          JSON.stringify({ hook_event_name: 'PostToolUse', transcript_path: transcriptPath, tool_name: 'Bash', tool_input: {}, tool_response: {} }),
      });
    }
    expect(postedEvents.some((e) => e.event_type === 'llm.completed')).toBe(false);
  });

  // Same reasoning for the lock-contention case: an unwritable store means no
  // persisted offset can be read or saved either, and a tool event that
  // cannot converge on a lock is dropped rather than scanned (ADR-023 B2).
  it('never scans the transcript when the session lock cannot be acquired', async () => {
    const transcriptPath = path.join(transcriptDir, 't.jsonl');
    fs.writeFileSync(transcriptPath, assistantLine('msg_1', 'a1') + '\n');
    const blocker = path.join(cacheDir, 'blocker-file');
    fs.writeFileSync(blocker, 'x');
    const badEnv = { ...CONFIGURED, XDG_CACHE_HOME: path.join(blocker, 'nope') } as NodeJS.ProcessEnv;
    await runHook(['--harness', 'claude-code'], badEnv, {
      fetch: fetchImpl,
      readInput: async () =>
        JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'hs-degraded', transcript_path: transcriptPath, tool_name: 'Bash', tool_input: {}, tool_response: {} }),
      hardTimeoutMs: 700,
    });
    expect(postedEvents.some((e) => e.event_type === 'tool.completed')).toBe(false);
    expect(postedEvents.some((e) => e.event_type === 'llm.completed')).toBe(false);
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
