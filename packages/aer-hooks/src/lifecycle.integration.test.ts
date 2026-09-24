import { it, expect, beforeAll, afterAll, describe } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from './install.js';
import { distProblem } from '../../../scripts/require-dist.mjs';

// The README promises the built hook never breaks a harness: it exits 0 on
// every path and never writes to stdout. And the changeset promises one AER
// session opened and completed across a harness session. Both were only ever
// tested in process. This runs the actual built binary the way Claude Code
// runs it, and holds both promises there.

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hookBin = join(pkgRoot, 'dist', 'cli.js');
const caches: string[] = [];

// Tests never build. A sibling file spawning this dist would load it half
// written, so dist comes from one build that finishes before any test runs.
beforeAll(() => {
  const problem = distProblem(pkgRoot);
  if (problem) throw new Error(problem);
});

afterAll(() => {
  for (const c of caches) rmSync(c, { recursive: true, force: true });
});

function freshCache(): string {
  const c = mkdtempSync(join(tmpdir(), 'aer-hook-cache-'));
  caches.push(c);
  return c;
}

function baseEnv(cache: string, baseUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AER_BASE_URL: baseUrl,
    AER_API_KEY: 'aer_probe',
    AER_TENANT_ID: '01950000-0000-7000-8000-0000000000aa',
    AER_AGENT_ID: '01950000-0000-7000-8000-0000000000ac',
    AER_ENV_ID: '01950000-0000-7000-8000-0000000000ad',
    AER_HOOK_TIMEOUT_MS: '4000',
    XDG_CACHE_HOME: cache,
  };
}

function event(name: string): Record<string, unknown> {
  return {
    session_id: 'harness-session-1',
    hook_event_name: name,
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_response: { stdout: 'x' },
    source: 'startup',
    last_assistant_message: 'done',
    cwd: '/tmp',
  };
}

describe('the built aer-hook binary, fail-open', () => {
  // Port 9 refuses at once, so the hook fails its network call immediately
  // rather than sitting on its timeout. The point is the exit-0 promise.
  it.each(['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit'])(
    'exits 0 and writes nothing to stdout on %s when the API is unreachable',
    (name) => {
      const r = spawnSync(process.execPath, [hookBin, '--harness', 'claude-code'], {
        input: JSON.stringify(event(name)),
        encoding: 'utf8',
        timeout: 20_000,
        env: baseEnv(freshCache(), 'http://127.0.0.1:9'),
      });
      expect(r.status, `${name} exit; stderr: ${r.stderr}`).toBe(0);
      expect(r.stdout, `${name} wrote to stdout`).toBe('');
    },
  );
});

// spawnSync blocks the event loop, so an in-process server cannot answer a
// hook that spawnSync is waiting on. Drive the hook with async spawn instead,
// so the same-process server keeps serving while the hook runs.
function runHookAsync(
  cache: string,
  baseUrl: string,
  ev: Record<string, unknown>,
  extraArgs: string[] = [],
  envExtra: NodeJS.ProcessEnv = {},
): Promise<number> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [hookBin, '--harness', 'claude-code', ...extraArgs], {
      env: { ...baseEnv(cache, baseUrl), ...envExtra },
    });
    child.stdin.end(JSON.stringify(ev));
    child.on('close', (code) => resolvePromise(code ?? -1));
  });
}

describe('one AER session across a harness session', () => {
  it('opens on SessionStart and completes once on Stop, through the built binary', async () => {
    const seen: string[] = [];
    const server: Server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        const json = (code: number, obj: unknown): void => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        if (req.method === 'POST' && req.url === '/v1/sessions') return json(201, { agent_session_id: '01950000-0000-7000-8000-0000000000ee', ingest_token: 'tok' });
        if (req.method === 'POST' && /\/events$/.test(req.url ?? '')) return json(200, { accepted: 1, rejected: 0, events_sanitized: 1, dropped_keys: 1, warning: 'payload_keys_dropped' });
        if (req.method === 'POST' && /\/complete$/.test(req.url ?? '')) return json(200, { aer_id: '01950000-0000-7000-8000-0000000000af' });
        return json(404, { error: 'not_found' });
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const cache = freshCache();
    try {
      for (const name of ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop']) {
        const code = await runHookAsync(cache, `http://127.0.0.1:${port}`, event(name));
        expect(code, `${name} exit`).toBe(0);
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    expect(seen.filter((u) => u === 'POST /v1/sessions')).toHaveLength(1);
    expect(seen.filter((u) => /\/complete$/.test(u))).toHaveLength(1);
  }, 40_000);
});

/** A server that records every request line and every posted body. */
function recordingServer(seen: string[], bodies: string[]): Server {
  return createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      bodies.push(body);
      const json = (code: number, obj: unknown): void => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'POST' && req.url === '/v1/sessions') return json(201, { agent_session_id: '01950000-0000-7000-8000-0000000000ee', ingest_token: 'tok' });
      if (req.method === 'POST' && /\/events$/.test(req.url ?? '')) return json(200, { accepted: 1, rejected: 0 });
      if (req.method === 'POST' && /\/complete$/.test(req.url ?? '')) return json(200, { aer_id: '01950000-0000-7000-8000-0000000000af' });
      return json(404, { error: 'not_found' });
    });
  });
}

// The bug this covers was measured against the real CLI: one `claude -p` run
// continued with `--continue` produced TWO signed records for one
// conversation, because Stop fires per turn and we completed on it. A record
// that splits a conversation misrepresents what the agent did in it.
describe('a multi-turn harness session is one record', () => {
  it('does not complete on Stop, and completes once on SessionEnd', async () => {
    const seen: string[] = [];
    const bodies: string[] = [];
    const server = recordingServer(seen, bodies);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const cache = freshCache();
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      // Two full turns, then the session actually ending.
      const names = [
        'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop',
        'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop',
        'SessionEnd',
      ];
      for (const name of names) {
        const code = await runHookAsync(cache, baseUrl, event(name), ['--lifecycle', 'v2']);
        expect(code, `${name} exit`).toBe(0);
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }

    expect(seen.filter((u) => u === 'POST /v1/sessions')).toHaveLength(1);
    expect(seen.filter((u) => /\/complete$/.test(u))).toHaveLength(1);

    const all = bodies.join('\n');
    expect(all).toContain('"phase":"turn_end"');
    // The shell call is recorded as the program it ran, not just as a tool
    // named Bash, and the command line itself never appears.
    expect(all).toContain('"command":"ls"');
    expect(all).toContain('"command_known":true');
    expect(all).toContain('"phase":"session_end"');

    // Every event carries its position, and the positions run 1..10 with no
    // gap and no repeat, which is what makes a missing event detectable.
    const seqs = [...all.matchAll(/"seq":(\d+)/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
    // Twelve events from ten invocations: each Bash call also records the
    // program it ran, and every position is distinct.
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  }, 90_000);

  it('still completes on Stop for a registration written before SessionEnd', async () => {
    // An installed hook from an earlier release never registers SessionEnd,
    // so if Stop stopped completing, that user would silently stop getting
    // records at all. The absent flag keeps the old meaning.
    const seen: string[] = [];
    const bodies: string[] = [];
    const server = recordingServer(seen, bodies);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const cache = freshCache();
    try {
      for (const name of ['SessionStart', 'Stop']) {
        await runHookAsync(cache, `http://127.0.0.1:${port}`, event(name));
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    expect(seen.filter((u) => /\/complete$/.test(u))).toHaveLength(1);
  }, 40_000);
});

// A reader of the record has to be able to tell "the agent used two tools"
// from "the recorder saw two of the tools the agent used".
describe('the record says how complete it is', () => {
  it('declares what was registered at the start and what arrived at the end', async () => {
    const seen: string[] = [];
    const bodies: string[] = [];
    const server = recordingServer(seen, bodies);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const cache = freshCache();
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      // Read the registration out of a home we control, so the assertion is
      // about the code and not about the machine running the test.
      const home = freshCache();
      await install('claude-code', { dir: home });
      // A tool that starts and never finishes: the harness was interrupted.
      for (const name of ['SessionStart', 'PreToolUse', 'PostToolUse', 'PreToolUse', 'SessionEnd']) {
        await runHookAsync(cache, baseUrl, { ...event(name), cwd: home }, ['--lifecycle', 'v2'], { HOME: home });
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    const all = bodies.join('\n');
    // The opening marker names the collector and the events the harness will
    // call it for, read from the harness's own config rather than asserted.
    expect(all).toContain('"collector":"aer-hooks"');
    expect(all).toContain('"events_registered":["PostToolUse","PreToolUse","SessionEnd","SessionStart","Stop","SubagentStart","SubagentStop","UserPromptSubmit"]');
    // The closing marker counts what arrived and what never resolved.
    expect(all).toContain('"events_emitted":7');
    expect(all).toContain('"tools_unresolved":1');
  }, 60_000);
});
