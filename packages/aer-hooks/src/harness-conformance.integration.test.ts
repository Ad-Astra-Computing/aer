// Drive the built binary with payloads captured from the real CLIs.

// Every fixture here was recorded by running the actual harness with a probe
// hook. The docs and the payloads disagree, so the payloads win.

import { it, expect, beforeAll, afterAll, describe } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hookBin = join(pkgRoot, 'dist', 'cli.js');
const dirs: string[] = [];

// Tests never build. A sibling file spawning this dist would load it half
// written, so dist comes from one build that finishes before any test runs.
beforeAll(() => {
  if (!existsSync(hookBin)) throw new Error('dist is missing: run pnpm -r build first');
});

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'aer-conf-'));
  dirs.push(d);
  return d;
}

interface Posted { url: string; body: string }

function server(posted: Posted[]): Server {
  return createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      posted.push({ url: req.url ?? '', body });
      res.writeHead(req.url === '/v1/sessions' ? 201 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ agent_session_id: '01950000-0000-7000-8000-0000000000ee', ingest_token: 'tok', aer_id: 'x' }));
    });
  });
}

function runHook(cache: string, baseUrl: string, args: string[], payload: unknown): Promise<number> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [hookBin, ...args], {
      env: {
        ...process.env,
        AER_BASE_URL: baseUrl,
        AER_API_KEY: 'aer_probe',
        AER_TENANT_ID: '01950000-0000-7000-8000-0000000000aa',
        AER_AGENT_ID: '01950000-0000-7000-8000-0000000000ac',
        AER_ENV_ID: '01950000-0000-7000-8000-0000000000ad',
        AER_HOOK_TIMEOUT_MS: '8000',
        XDG_CACHE_HOME: cache,
        HOME: cache,
      },
    });
    child.stdin.end(JSON.stringify(payload));
    child.on('close', (c) => done(c ?? -1));
  });
}

async function drive(args: string[], payloads: { args?: string[]; payload: unknown }[]): Promise<Posted[]> {
  const posted: Posted[] = [];
  const s = server(posted);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  const cache = freshDir();
  try {
    for (const step of payloads) {
      const code = await runHook(cache, `http://127.0.0.1:${port}`, [...args, ...(step.args ?? [])], step.payload);
      expect(code).toBe(0);
    }
  } finally {
    await new Promise<void>((r) => s.close(() => r()));
  }
  return posted;
}

const counts = (posted: Posted[]) => ({
  opened: posted.filter((p) => p.url === '/v1/sessions').length,
  completed: posted.filter((p) => p.url.endsWith('/complete')).length,
});

// Recorded from Claude Code 2.x with a probe hook on every event.
const CLAUDE = [
  { session_id: 'cc-1', transcript_path: '/t', cwd: '/w', hook_event_name: 'SessionStart', source: 'startup' },
  { session_id: 'cc-1', transcript_path: '/t', cwd: '/w', prompt_id: 'pr_1', permission_mode: 'default', hook_event_name: 'UserPromptSubmit', prompt: 'SECRET-PROMPT' },
  { session_id: 'cc-1', transcript_path: '/t', cwd: '/w', prompt_id: 'pr_1', permission_mode: 'default', effort: { level: 'medium' }, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status # SECRET-ARG' }, tool_use_id: 'toolu_1' },
  { session_id: 'cc-1', transcript_path: '/t', cwd: '/w', prompt_id: 'pr_1', permission_mode: 'default', effort: { level: 'medium' }, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git status # SECRET-ARG' }, tool_response: { stdout: 'SECRET-OUTPUT' }, tool_use_id: 'toolu_1', duration_ms: 12 },
  { session_id: 'cc-1', transcript_path: '/t', cwd: '/w', prompt_id: 'pr_1', permission_mode: 'default', effort: { level: 'medium' }, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'SECRET-REPLY' },
  { session_id: 'cc-1', transcript_path: '/t', cwd: '/w', prompt_id: 'pr_1', hook_event_name: 'SessionEnd', reason: 'other' },
];

// Recorded from codex-cli 0.154.0.
const CODEX = [
  { session_id: 'cx-1', transcript_path: '/t', cwd: '/w', hook_event_name: 'SessionStart', model: 'gpt-6-astra', permission_mode: 'bypassPermissions', source: 'startup' },
  { session_id: 'cx-1', turn_id: '01a0c1f6-78ce-7fb3-ae24-b084f9154316', transcript_path: '/t', cwd: '/w', hook_event_name: 'UserPromptSubmit', model: 'gpt-6-astra', permission_mode: 'bypassPermissions', prompt: 'SECRET-PROMPT' },
  { session_id: 'cx-1', turn_id: '01a0c1f6-78ce-7fb3-ae24-b084f9154316', transcript_path: '/t', cwd: '/w', hook_event_name: 'SessionEnd', model: 'gpt-6-astra', reason: 'other' },
];

// Recorded from agy 1.2.2. No hook_event_name: the name rides on argv.
const AGY = [
  { args: ['--event', 'PreInvocation'], payload: { artifactDirectoryPath: '/b', conversationId: 'agy-1', initialNumSteps: 1, invocationNum: 0, modelName: 'gemini-3.8-flash-high', transcriptPath: '/t', workspacePaths: [] } },
  { args: ['--event', 'PostInvocation'], payload: { artifactDirectoryPath: '/b', conversationId: 'agy-1', initialNumSteps: 1, invocationNum: 0, modelName: 'gemini-3.8-flash-high', transcriptPath: '/t', workspacePaths: [] } },
  { args: ['--event', 'PreInvocation'], payload: { artifactDirectoryPath: '/b', conversationId: 'agy-1', initialNumSteps: 3, invocationNum: 1, modelName: 'gemini-3.8-flash-high', transcriptPath: '/t', workspacePaths: [] } },
  { args: ['--event', 'Stop'], payload: { artifactDirectoryPath: '/b', conversationId: 'agy-1', error: '', executionNum: 0, fullyIdle: true, modelName: 'gemini-3.8-flash-high', terminationReason: 'NO_TOOL_CALL', transcriptPath: '/t', workspacePaths: [] } },
];

describe('a real Claude Code run', () => {
  it('is one record, whatever the turn count', async () => {
    const posted = await drive(['--harness', 'claude-code', '--lifecycle', 'v2'], CLAUDE.map((payload) => ({ payload })));
    expect(counts(posted)).toEqual({ opened: 1, completed: 1 });
  }, 60_000);

  it('carries the effort, the turn and the program that ran', async () => {
    const all = (await drive(['--harness', 'claude-code', '--lifecycle', 'v2'], CLAUDE.map((payload) => ({ payload })))).map((p) => p.body).join('\n');
    expect(all).toContain('"effort":"medium"');
    expect(all).toContain('"turn_id":"pr_1"');
    expect(all).toContain('"tool_use_id":"toolu_1"');
    expect(all).toContain('"command":"git"');
    expect(all).toContain('"harness":"claude-code"');
  }, 60_000);
});

describe('a real Codex run', () => {
  it('is one record and carries the model Codex sends on every event', async () => {
    const posted = await drive(['--harness', 'codex', '--lifecycle', 'v2'], CODEX.map((payload) => ({ payload })));
    expect(counts(posted)).toEqual({ opened: 1, completed: 1 });
    const all = posted.map((p) => p.body).join('\n');
    expect(all).toContain('"model":"gpt-6-astra"');
    expect(all).toContain('"turn_id":"01a0c1f6-78ce-7fb3-ae24-b084f9154316"');
  }, 60_000);
});

describe('a real Antigravity run', () => {
  it('opens once on the zero-numbered invocation and completes on Stop', async () => {
    const posted = await drive(['--harness', 'antigravity', '--lifecycle', 'v2'], AGY);
    expect(counts(posted)).toEqual({ opened: 1, completed: 1 });
    const all = posted.map((p) => p.body).join('\n');
    expect(all).toContain('"model":"gemini-3.8-flash-high"');
    expect(all).toContain('"reason":"NO_TOOL_CALL"');
    // The second invocation is a turn, not another session.
    expect(all).toContain('"phase":"turn_start"');
  }, 60_000);
});

describe('bodies-off holds against every real payload', () => {
  it('never puts prompt, output, reply or argument text on the wire', async () => {
    const all = [
      ...(await drive(['--harness', 'claude-code', '--lifecycle', 'v2'], CLAUDE.map((payload) => ({ payload })))),
      ...(await drive(['--harness', 'codex', '--lifecycle', 'v2'], CODEX.map((payload) => ({ payload })))),
      ...(await drive(['--harness', 'antigravity', '--lifecycle', 'v2'], AGY)),
    ].map((p) => p.body).join('\n');

    for (const secret of ['SECRET-PROMPT', 'SECRET-OUTPUT', 'SECRET-REPLY', 'SECRET-ARG', 'stdout']) {
      expect(all, `${secret} reached the wire`).not.toContain(secret);
    }
    // The transcript path is the harness's own file and is never recorded.
    expect(all).not.toContain('transcript');
  }, 90_000);
});
