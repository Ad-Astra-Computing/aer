import { it, expect, beforeAll, afterAll, describe } from 'vitest';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The README promises the built hook never breaks a harness: it exits 0 on
// every path and never writes to stdout. And the changeset promises one AER
// session opened and completed across a harness session. Both were only ever
// tested in process. This runs the actual built binary the way Claude Code
// runs it, and holds both promises there.

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkgRoot, '../..');
const hookBin = join(pkgRoot, 'dist', 'cli.js');
const caches: string[] = [];

beforeAll(() => {
  const tsc = join(repoRoot, 'node_modules', '.bin', 'tsc');
  // Do not swallow tsc output: a compile error must read as a compile error,
  // not as a later ENOENT on dist/cli.js.
  execFileSync(tsc, ['-p', 'tsconfig.json'], { cwd: pkgRoot, stdio: 'pipe' });
}, 60_000);

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
function runHookAsync(cache: string, baseUrl: string, ev: Record<string, unknown>): Promise<number> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [hookBin, '--harness', 'claude-code'], { env: baseEnv(cache, baseUrl) });
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
