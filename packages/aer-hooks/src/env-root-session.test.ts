// ADR-023 B1, revised after review against Claude Code 2.1.281 (25 Sep
// 2026): `--root-session "${CLAUDE_SESSION_ID}"` expanded to EMPTY; the
// variable actually exported into the hook env is `CLAUDE_CODE_SESSION_ID`,
// identically for the lead and a subagent. That run's subagent payload
// already carried the lead's own session_id, so own-key match alone joined
// it; the env var covers harness versions where that does not hold.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runHook, rootSessionFromEnv, type RunHookDeps } from './cli.js';

const CONFIGURED = {
  AER_API_KEY: 'k',
  AER_TENANT_ID: 't',
  AER_AGENT_ID: 'agent-1',
  AER_BASE_URL: 'https://api.test',
} as NodeJS.ProcessEnv;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('rootSessionFromEnv', () => {
  it('prefers CLAUDE_CODE_SESSION_ID, the variable Claude Code 2.1.281 actually exports', () => {
    expect(rootSessionFromEnv({ CLAUDE_CODE_SESSION_ID: 'ses-real', CLAUDE_SESSION_ID: 'ses-other' })).toBe('ses-real');
  });

  it('falls back to CLAUDE_SESSION_ID for a harness or future release that uses that name', () => {
    expect(rootSessionFromEnv({ CLAUDE_SESSION_ID: 'ses-fallback' })).toBe('ses-fallback');
  });

  it('is undefined when neither is set or the value is empty', () => {
    expect(rootSessionFromEnv({})).toBeUndefined();
    expect(rootSessionFromEnv({ CLAUDE_CODE_SESSION_ID: '' })).toBeUndefined();
  });
});

describe('root-session join via the hook environment, not shell expansion', () => {
  let cacheDir: string;
  let opens: number;
  let eventSessionIds: string[];
  let fetchImpl: typeof fetch;

  function envWith(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return { ...CONFIGURED, XDG_CACHE_HOME: cacheDir, ...extra } as NodeJS.ProcessEnv;
  }
  function fire(payload: Record<string, unknown>, env: NodeJS.ProcessEnv, deps: RunHookDeps = {}): Promise<void> {
    return runHook(['--harness', 'claude-code', '--lifecycle', 'v2'], env, {
      readInput: async () => JSON.stringify(payload),
      fetch: fetchImpl,
      ...deps,
    });
  }

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aer-hooks-envroot-'));
    opens = 0;
    eventSessionIds = [];
    fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/v1/sessions')) {
        opens += 1;
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

  it('joins a subagent whose OWN session id differs from the lead, via CLAUDE_CODE_SESSION_ID', async () => {
    const lead = 'lead-env-1';
    // The lead's SessionStart, invoked with the env var Claude Code exports.
    await fire({ hook_event_name: 'SessionStart', session_id: lead }, envWith({ CLAUDE_CODE_SESSION_ID: lead }));
    // A subagent hook whose payload session_id is genuinely its own, distinct
    // from the lead - the scenario the shell-expansion flag never covered and
    // the empirical run did not happen to exercise, but the env var does.
    await fire(
      { hook_event_name: 'PreToolUse', session_id: 'subagent-own-id', tool_name: 'Bash', tool_input: {}, agent_id: 'agent-9' },
      envWith({ CLAUDE_CODE_SESSION_ID: lead }),
    );
    expect(opens).toBe(1);
    expect(new Set(eventSessionIds)).toEqual(new Set(['sess-1']));
  });

  it('prefers an existing session under the event\'s OWN id over the env-derived root (own-key match first)', async () => {
    // Empirical case: the subagent's payload session_id ALREADY equals the
    // lead's. A wrong or stale env value must not override a direct hit.
    const lead = 'lead-env-2';
    await fire({ hook_event_name: 'SessionStart', session_id: lead }, envWith({ CLAUDE_CODE_SESSION_ID: lead }));
    await fire(
      { hook_event_name: 'PreToolUse', session_id: lead, tool_name: 'Bash', tool_input: {}, agent_id: 'agent-9' },
      // A deliberately WRONG env value: if own-key match did not win first,
      // this would open a second, unrelated session.
      envWith({ CLAUDE_CODE_SESSION_ID: 'some-other-session-entirely' }),
    );
    expect(opens).toBe(1);
    expect(new Set(eventSessionIds)).toEqual(new Set(['sess-1']));
  });

  it('an explicit --root-session flag still overrides the env var', async () => {
    const lead = 'lead-env-3';
    await fire({ hook_event_name: 'SessionStart', session_id: lead }, envWith({ CLAUDE_CODE_SESSION_ID: lead }));
    await runHook(
      ['--harness', 'claude-code', '--lifecycle', 'v2', '--root-session', lead],
      envWith({ CLAUDE_CODE_SESSION_ID: 'wrong-value' }),
      { readInput: async () => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sub', tool_name: 'Bash', tool_input: {}, agent_id: 'agent-9' }), fetch: fetchImpl },
    );
    expect(opens).toBe(1);
    expect(new Set(eventSessionIds)).toEqual(new Set(['sess-1']));
  });

  it('the historically-broken unexpanded flag is ignored and the env var still joins the record', async () => {
    const lead = 'lead-env-4';
    await fire({ hook_event_name: 'SessionStart', session_id: lead }, envWith({ CLAUDE_CODE_SESSION_ID: lead }));
    await runHook(
      // Exactly what the pre-fix installer wrote: the literal, unexpanded placeholder.
      ['--harness', 'claude-code', '--lifecycle', 'v2', '--root-session', '${CLAUDE_SESSION_ID}'],
      envWith({ CLAUDE_CODE_SESSION_ID: lead }),
      { readInput: async () => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'sub-2', tool_name: 'Bash', tool_input: {}, agent_id: 'agent-9' }), fetch: fetchImpl },
    );
    expect(opens).toBe(1);
    expect(new Set(eventSessionIds)).toEqual(new Set(['sess-1']));
  });
});
