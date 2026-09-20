/**
 * Antigravity fires the same shell-hook contract as Claude Code and Codex, but
 * three differences make a shared normalizer wrong:
 *
 *  - The payload never names the event, so the event has to arrive on argv.
 *  - There is no SessionStart. PreInvocation fires on every turn, so only the
 *    first (invocationNum 1) opens a session, and Stop fires on any
 *    termination, so only fullyIdle closes one. Getting either wrong either
 *    reopens a session per turn or strands it open forever.
 *  - Tool fields are camelCase and nested: toolCall.name, toolCall.args, with
 *    the error a top-level string rather than a flag inside a response object.
 *
 * Field names verified against antigravity.google/docs/hooks.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { normalizeAntigravity, detectHarness, normalize } from './normalize.js';
import { parseHarnessFlag, parseEventFlag, runHook } from './cli.js';

const BASE = {
  conversationId: 'conv-7',
  workspacePaths: ['/home/dev/app'],
  transcriptPath: '/tmp/t.json',
  artifactDirectoryPath: '/tmp/a',
  modelName: 'gemini-3-pro',
};

describe('normalizeAntigravity', () => {
  it('reads the tool name and argument keys from toolCall on PreToolUse', () => {
    const e = normalizeAntigravity(
      { ...BASE, stepIdx: 2, toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf /', Cwd: '/' } } },
      'PreToolUse',
    );

    expect(e.kind).toBe('tool_start');
    expect(e.tool).toBe('run_command');
    expect(e.argKeys).toEqual(['CommandLine', 'Cwd']);
    expect(e.sessionRef).toBe('conv-7');
  });

  it('never carries argument values', () => {
    const e = normalizeAntigravity(
      { ...BASE, toolCall: { name: 'run_command', args: { CommandLine: 'curl https://secret.example' } } },
      'PreToolUse',
    );

    expect(JSON.stringify(e)).not.toContain('secret.example');
    expect(JSON.stringify(e)).not.toContain('curl');
  });

  it('treats a PostToolUse with no error as a success', () => {
    const e = normalizeAntigravity({ ...BASE, toolCall: { name: 'view_file', args: {} } }, 'PostToolUse');

    expect(e.kind).toBe('tool_end');
    expect(e.ok).toBe(true);
    expect(e.isError).toBe(false);
  });

  it('reads the top-level error string PostToolUse reports failures with', () => {
    const e = normalizeAntigravity(
      { ...BASE, toolCall: { name: 'run_command', args: {} }, error: 'exit status 1' },
      'PostToolUse',
    );

    expect(e.isError).toBe(true);
    expect(e.ok).toBe(false);
  });

  it('does not leak the error text, which can quote command output', () => {
    const e = normalizeAntigravity(
      { ...BASE, toolCall: { name: 'run_command', args: {} }, error: 'fatal: token ghp_abc123 rejected' },
      'PostToolUse',
    );

    expect(JSON.stringify(e)).not.toContain('ghp_abc123');
  });

  it('opens a session on the first invocation only', () => {
    expect(normalizeAntigravity({ ...BASE, invocationNum: 1 }, 'PreInvocation').kind).toBe('session_start');
    expect(normalizeAntigravity({ ...BASE, invocationNum: 2 }, 'PreInvocation').kind).toBe('other');
    expect(normalizeAntigravity({ ...BASE, invocationNum: 9 }, 'PreInvocation').kind).toBe('other');
  });

  it('treats a PreInvocation with no invocationNum as the first one', () => {
    // Absent rather than wrong: opening the session is recoverable, never
    // opening it loses the whole run.
    expect(normalizeAntigravity({ ...BASE }, 'PreInvocation').kind).toBe('session_start');
  });

  it('closes the session only when the agent is fully idle', () => {
    expect(normalizeAntigravity({ ...BASE, fullyIdle: true }, 'Stop').kind).toBe('session_end');
    expect(normalizeAntigravity({ ...BASE, fullyIdle: false }, 'Stop').kind).toBe('other');
  });

  it('closes the session when Stop omits fullyIdle', () => {
    // A stranded session never produces an AER, so an unknown Stop closes.
    expect(normalizeAntigravity({ ...BASE }, 'Stop').kind).toBe('session_end');
  });

  it('drops PostInvocation, which is a turn boundary and not a session one', () => {
    expect(normalizeAntigravity({ ...BASE, invocationNum: 1 }, 'PostInvocation').kind).toBe('other');
  });

  it('yields a harmless event when the event name is missing or unknown', () => {
    expect(normalizeAntigravity(BASE, '').kind).toBe('other');
    expect(normalizeAntigravity(BASE, 'SomethingNew').kind).toBe('other');
  });

  it('survives a payload that is not an object', () => {
    expect(normalizeAntigravity(null, 'PreToolUse').kind).toBe('tool_start');
    expect(normalizeAntigravity('nope', 'Stop').kind).toBe('session_end');
  });
});

describe('detectHarness with an Antigravity payload', () => {
  it('recognizes conversationId without hook_event_name', () => {
    expect(detectHarness({ ...BASE, toolCall: { name: 'view_file', args: {} } })).toBe('antigravity');
  });

  it('does not steal a Claude Code payload', () => {
    expect(detectHarness({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash' })).toBe('claude-code');
  });

  it('does not steal a Codex payload', () => {
    expect(detectHarness({ session_id: 's', hook_event_name: 'PreToolUse', turn_id: 't1' })).toBe('codex');
  });
});

describe('normalize routes to Antigravity with the event name', () => {
  it('uses the supplied event name when the harness is antigravity', () => {
    const e = normalize(
      { ...BASE, toolCall: { name: 'view_file', args: { Path: 'a.ts' } } },
      'antigravity',
      process.env,
      'PostToolUse',
    );

    expect(e.kind).toBe('tool_end');
    expect(e.tool).toBe('view_file');
  });

  it('is inert rather than wrong when the event name was not passed', () => {
    const e = normalize({ ...BASE, toolCall: { name: 'view_file', args: {} } }, 'antigravity');
    expect(e.kind).toBe('other');
  });
});

/**
 * The event name is the one thing Antigravity cannot supply in the payload, so
 * argv parsing is load-bearing here in a way it is not for the other two
 * harnesses. A dropped --event turns every tool call into a dropped event.
 */
describe('argv parsing for Antigravity registrations', () => {
  it('accepts the harness in both spellings and by its short name', () => {
    expect(parseHarnessFlag(['--harness', 'antigravity'])).toBe('antigravity');
    expect(parseHarnessFlag(['--harness=antigravity'])).toBe('antigravity');
    expect(parseHarnessFlag(['--harness=agy'])).toBe('antigravity');
    expect(parseHarnessFlag(['--harness', 'agy'])).toBe('antigravity');
  });

  it('leaves the other harnesses working', () => {
    expect(parseHarnessFlag(['--harness=codex'])).toBe('codex');
    expect(parseHarnessFlag(['--harness', 'claude-code'])).toBe('claude-code');
    expect(parseHarnessFlag(['--harness=nonsense'])).toBeUndefined();
    expect(parseHarnessFlag([])).toBeUndefined();
  });

  it('reads the event name in both spellings', () => {
    expect(parseEventFlag(['--event', 'PreToolUse'])).toBe('PreToolUse');
    expect(parseEventFlag(['--event=Stop'])).toBe('Stop');
    expect(parseEventFlag(['--harness=agy', '--event=PostToolUse'])).toBe('PostToolUse');
    expect(parseEventFlag([])).toBeUndefined();
  });
});

describe('runHook end to end on an Antigravity payload', () => {
  const CONFIGURED = {
    AER_API_KEY: 'k',
    AER_TENANT_ID: 't',
    AER_AGENT_ID: 'a',
    AER_BASE_URL: 'https://api.test',
  } as NodeJS.ProcessEnv;

  function stubFetch() {
    const calls: Array<{ url: string; body: string }> = [];
    const fake = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
      if (url.endsWith('/v1/sessions')) {
        return new Response(JSON.stringify({ id: 's1', ingest_token: 'tok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fake);
    return calls;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('records the tool name and argument keys, and neither value', async () => {
    const calls = stubFetch();

    await runHook(['--harness=agy', '--event=PreToolUse'], CONFIGURED, {
      readInput: async () =>
        JSON.stringify({
          ...BASE,
          stepIdx: 1,
          toolCall: { name: 'run_command', args: { CommandLine: 'curl https://exfil.example' } },
        }),
    });

    const events = calls.filter((c) => c.url.endsWith('/events'));
    expect(events).toHaveLength(1);
    const body = events[0]!.body;
    expect(body).toContain('run_command');
    expect(body).toContain('CommandLine');
    expect(body).not.toContain('exfil.example');
    expect(body).not.toContain('curl');
  });

  it('emits nothing for a Stop that is not the end of the run', async () => {
    const calls = stubFetch();

    await runHook(['--harness=agy', '--event=Stop'], CONFIGURED, {
      readInput: async () => JSON.stringify({ ...BASE, fullyIdle: false, terminationReason: 'user_turn' }),
    });

    expect(calls).toHaveLength(0);
  });

  it('detects the harness from the payload when --harness is omitted', async () => {
    const calls = stubFetch();

    await runHook(['--event=PreToolUse'], CONFIGURED, {
      readInput: async () =>
        JSON.stringify({ ...BASE, toolCall: { name: 'view_file', args: { Path: 'a.ts' } } }),
    });

    const events = calls.filter((c) => c.url.endsWith('/events'));
    expect(events).toHaveLength(1);
    expect(events[0]!.body).toContain('view_file');
  });
});
