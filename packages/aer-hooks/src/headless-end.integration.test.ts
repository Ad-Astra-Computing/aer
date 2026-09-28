// A harness does not wait long for a session end: Claude Code gives an entry
// with no timeout 1.5 s, then kills the hook's process group and every
// descendant it can find. The built binary is run here the way the harness
// runs it and killed the way the harness kills it, and the record must still
// complete, with no worker left behind afterwards.

import { it, expect, beforeAll, afterAll, describe } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
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
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const body = Buffer.concat(chunks);
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    try {
      const r = await api.fetch(`http://aer.test${req.url}`, { method: req.method, headers, body: body.length ? body.toString() : undefined, signal: controller.signal });
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(await r.text());
    } catch {
      res.destroy();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'],
    HOME: dir,
    XDG_CACHE_HOME: join(dir, 'cache'),
    TMPDIR: dir,
    AER_BASE_URL: baseUrl,
    AER_API_KEY: 'aer_probe',
    AER_TENANT_ID: '01950000-0000-7000-8000-0000000000aa',
    AER_AGENT_ID: '01950000-0000-7000-8000-0000000000ac',
    AER_ENV_ID: '01950000-0000-7000-8000-0000000000ad',
    ...extra,
  };
}

/** Every descendant of `pid` in the process table right now. */
function descendants(pid: number): number[] {
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' })
    .trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number) as [number, number]);
  const out: number[] = [];
  const walk = (p: number): void => {
    for (const [child, parent] of rows) if (parent === p) { out.push(child); walk(child); }
  };
  walk(pid);
  return out;
}

/** Kill the way the harness does: the process group, then every descendant it can find. */
function killLikeTheHarness(pid: number): void {
  const found = descendants(pid);
  try { process.kill(-pid, 'SIGKILL'); } catch { /* group already gone */ }
  for (const p of found) {
    try { process.kill(p, 'SIGKILL'); } catch { /* already gone */ }
  }
}

/** Run one hook as its own process group; at `killAtMs`, or when it exits if sooner, kill it and its descendants. */
function runHarnessStyle(payload: unknown, args: string[], killAtMs: number, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ ms: number; killedWhileRunning: boolean }> {
  return new Promise((done) => {
    const t = Date.now();
    const child = spawn(process.execPath, [hookBin, '--harness', 'claude-code', '--lifecycle', 'v2', ...args], { env: env(extraEnv), detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
    let killedWhileRunning = false;
    const timer = setTimeout(() => { killedWhileRunning = true; killLikeTheHarness(child.pid!); }, killAtMs);
    child.on('exit', () => {
      clearTimeout(timer);
      // Whatever the hook left in its group or below it goes too.
      killLikeTheHarness(child.pid!);
      done({ ms: Date.now() - t, killedWhileRunning });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function drainProcesses(storeKey: string): string[] {
  return execFileSync('ps', ['-eo', 'args='], { encoding: 'utf8' })
    .split('\n').filter((a) => a.includes(hookBin) && a.includes('--drain') && a.includes(storeKey));
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  for (const until = Date.now() + ms; Date.now() < until;) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

async function started(sid: string): Promise<void> {
  api.openDelayMs = 0;
  api.eventsDelayMs = 0;
  api.completeDelayMs = 0;
  const r = await runHarnessStyle({ session_id: sid, cwd: dir, hook_event_name: 'SessionStart' }, [], 20_000);
  expect(r.killedWhileRunning).toBe(false);
}

describe('a session end the harness cuts short', () => {
  it('completes through the worker when the harness kills the hook while it is still sending', async () => {
    api = new FakeApi();
    const sid = 'cc-killed-mid-send';
    await started(sid);
    api.openDelayMs = 2500;
    api.eventsDelayMs = 1500;
    api.completeDelayMs = 1500;
    // A declared budget keeps the hook sending past 1.5 s, so the kill lands while it runs.
    const end = await runHarnessStyle({ session_id: sid, cwd: dir, hook_event_name: 'SessionEnd', reason: 'other' }, ['--end-budget-ms', '8000'], 1500);
    expect(end.killedWhileRunning).toBe(true);
    expect(await waitFor(() => api.completes().length === 1, 20_000)).toBe(true);
    expect([...api.sessions.values()][0]!.events.map((e) => e.payload['phase'])).toEqual(['session_start', 'session_end']);
    expect(await waitFor(() => drainProcesses(sid).length === 0, 5000)).toBe(true);
    const log = readdirSync(join(dir, 'cache', 'aer-hooks')).includes('drain.log') ? readFileSync(join(dir, 'cache', 'aer-hooks', 'drain.log'), 'utf8') : '';
    expect(log).not.toMatch(/tok-|aer_probe/);
  }, 40_000);

  it('returns inside the harness budget with no declared one, and the worker survives the group being killed', async () => {
    api = new FakeApi();
    const sid = 'cc-no-budget';
    await started(sid);
    api.eventsDelayMs = 1500;
    api.completeDelayMs = 1500;
    const end = await runHarnessStyle({ session_id: sid, cwd: dir, hook_event_name: 'SessionEnd', reason: 'other' }, [], 1500);
    // Node startup on a loaded runner can eat into the 1.5 s; the hook itself
    // stops by then, so being killed while running would be the failure.
    expect(end.killedWhileRunning).toBe(false);
    expect(await waitFor(() => api.completes().length === 1, 20_000)).toBe(true);
    expect(await waitFor(() => drainProcesses(sid).length === 0, 5000)).toBe(true);
  }, 40_000);

  it('leaves no worker behind when the API never answers', async () => {
    api = new FakeApi();
    const sid = 'cc-api-down';
    await started(sid);
    api.openDelayMs = 600_000;
    api.eventsDelayMs = 600_000;
    api.completeDelayMs = 600_000;
    await runHarnessStyle({ session_id: sid, cwd: dir, hook_event_name: 'SessionEnd', reason: 'other' }, [], 1500, { AER_HOOK_DRAIN_BUDGET_MS: '4000' });
    expect(await waitFor(() => drainProcesses(sid).length > 0, 3000)).toBe(true);
    expect(await waitFor(() => drainProcesses(sid).length === 0, 15_000)).toBe(true);
    expect(api.completes()).toHaveLength(0);
  }, 40_000);
});
