// Claude Code in print mode gives SessionEnd hooks 1.5 s unless the entry
// sets its own timeout, then kills the hook and everything it started.
// Against a production-latency API that is not long enough to send the
// closing report and complete the record, so the built binary is run here
// the way the harness runs it, killed the way the harness kills it, and the
// record must still complete.

import { it, expect, beforeAll, afterAll, describe } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distProblem } from '../../../scripts/require-dist.mjs';
import { FakeApi } from './fake-api.test-support.js';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hookBin = join(pkgRoot, 'dist', 'cli.js');
let dir: string;
let api: FakeApi;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const problem = distProblem(pkgRoot);
  if (problem) throw new Error(problem);
  dir = mkdtempSync(join(tmpdir(), 'aer-headless-'));
  api = new FakeApi();
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const body = Buffer.concat(chunks);
    const r = await api.fetch(`http://aer.test${req.url}`, { method: req.method, headers, body: body.length ? body.toString() : undefined });
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(await r.text());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function env(): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'],
    HOME: dir,
    XDG_CACHE_HOME: join(dir, 'cache'),
    TMPDIR: join(dir),
    AER_BASE_URL: baseUrl,
    AER_API_KEY: 'aer_probe',
    AER_TENANT_ID: '01950000-0000-7000-8000-0000000000aa',
    AER_AGENT_ID: '01950000-0000-7000-8000-0000000000ac',
    AER_ENV_ID: '01950000-0000-7000-8000-0000000000ad',
  };
}

/** Run the hook as its own process group and, like the harness, kill the group after `killAfterMs`. */
function runKilled(payload: unknown, killAfterMs: number): Promise<{ ms: number; killed: boolean }> {
  return new Promise((done) => {
    const t = Date.now();
    const child = spawn(process.execPath, [hookBin, '--harness', 'claude-code', '--lifecycle', 'v2'], { env: env(), detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* already gone */ }
    }, killAfterMs);
    child.on('close', () => { clearTimeout(timer); done({ ms: Date.now() - t, killed }); });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

describe('a session end the harness cuts short', () => {
  it('still completes the record after the hook is killed at 1.5 s against a slow API', async () => {
    const lead = { session_id: 'cc-killed-end', cwd: dir };
    const start = await runKilled({ ...lead, hook_event_name: 'SessionStart' }, 20_000);
    expect(start.killed).toBe(false);
    api.openDelayMs = 2500;
    api.eventsDelayMs = 1500;
    api.completeDelayMs = 1500;
    const end = await runKilled({ ...lead, hook_event_name: 'SessionEnd', reason: 'other' }, 1500);
    // The hook itself hands off and returns inside the harness's budget.
    expect(end.killed).toBe(false);
    expect(end.ms).toBeLessThan(1500);
    expect(await waitFor(() => api.completes().length === 1, 20_000)).toBe(true);
    const s = [...api.sessions.values()][0]!;
    expect(s.status).toBe('completed');
    expect(s.events.map((e) => e.payload['phase'])).toEqual(['session_start', 'session_end']);
    // The worker's notes go to the state dir, never the harness, and never carry a token.
    const root = join(dir, 'cache', 'aer-hooks');
    const log = readdirSync(root).includes('drain.log') ? readFileSync(join(root, 'drain.log'), 'utf8') : '';
    expect(log).not.toMatch(/tok-|aer_probe/);
  }, 40_000);
});
