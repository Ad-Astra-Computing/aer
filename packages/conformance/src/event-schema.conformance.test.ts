// A fake API accepts anything, so posting to one says nothing about whether
// the record keeps the event. Hold each one to the schema the API uses.

// The bug this exists for: tool.started requires a tool name, and a nameless
// tool call was rejected per event and vanished with no error anywhere.

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EventSchema } from '@aer/schemas';
import { cleanEnv } from './env.js';

const here = dirname(fileURLToPath(import.meta.url));
const hooksRoot = join(here, '..', '..', 'aer-hooks');
const hookCli = join(hooksRoot, 'dist', 'cli.js');

beforeAll(() => {
  execFileSync(join(here, '..', '..', '..', 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], {
    cwd: hooksRoot, stdio: 'pipe',
  });
}, 60_000);

async function emitted(args: string[], payloads: { args?: string[]; payload: unknown }[]): Promise<unknown[]> {
  const bodies: string[] = [];
  const api: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += String(c)));
    req.on('end', () => {
      if (/\/events$/.test(req.url ?? '')) bodies.push(body);
      res.writeHead(req.url === '/v1/sessions' ? 201 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ agent_session_id: '01950000-0000-7000-8000-0000000000ee', ingest_token: 'tok', aer_id: 'x' }));
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  const cache = mkdtempSync(join(tmpdir(), 'aer-schema-'));
  try {
    for (const step of payloads) {
      await new Promise<void>((done) => {
        const child = spawn(process.execPath, [hookCli, ...args, ...(step.args ?? [])], {
          env: cleanEnv({
            AER_BASE_URL: base,
            AER_API_KEY: 'aer_probe',
            AER_TENANT_ID: '01950000-0000-7000-8000-0000000000aa',
            AER_AGENT_ID: '01950000-0000-7000-8000-0000000000ac',
            AER_ENV_ID: '01950000-0000-7000-8000-0000000000ad',
            XDG_CACHE_HOME: cache,
            HOME: cache,
          }),
        });
        child.stdin.end(JSON.stringify(step.payload));
        child.on('close', () => done());
      });
    }
  } finally {
    await new Promise((r) => api.close(() => r(null)));
    rmSync(cache, { recursive: true, force: true });
  }
  return bodies.flatMap((b) => JSON.parse(b) as unknown[]);
}

function expectAllValid(events: unknown[]): void {
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) {
    const parsed = EventSchema.safeParse(event);
    const type = (event as { event_type?: string }).event_type;
    expect(parsed.success, `${type} rejected: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`).toBe(true);
  }
}

describe('every event the hook emits is one the API will accept', () => {
  it('holds for a Claude Code run', async () => {
    expectAllValid(await emitted(['--harness', 'claude-code', '--lifecycle', 'v2'], [
      { payload: { session_id: 's', hook_event_name: 'SessionStart', source: 'startup', cwd: '/w' } },
      { payload: { session_id: 's', hook_event_name: 'UserPromptSubmit', prompt_id: 'p1', prompt: 'x' } },
      { payload: { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' }, tool_use_id: 't1', effort: { level: 'high' } } },
      { payload: { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/a/b.ts' }, tool_use_id: 't2' } },
      { payload: { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url: 'https://h.example.com/p' }, tool_use_id: 't3' } },
      { payload: { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: 'x' }, tool_use_id: 't1' } },
      { payload: { session_id: 's', hook_event_name: 'Stop' } },
      { payload: { session_id: 's', hook_event_name: 'SessionEnd', reason: 'clear' } },
    ]));
  }, 90_000);

  it('holds when the harness sends a tool event with no tool name', async () => {
    // The event that used to be rejected. It must still reach the record as
    // something, and whatever it is must validate.
    expectAllValid(await emitted(['--harness', 'codex', '--lifecycle', 'v2'], [
      { payload: { session_id: 'n', hook_event_name: 'SessionStart', model: 'gpt-6-astra' } },
      { payload: { session_id: 'n', hook_event_name: 'PreToolUse', tool_input: { command: 'ls' } } },
      { payload: { session_id: 'n', hook_event_name: 'SessionEnd', reason: 'other' } },
    ]));
  }, 90_000);

  it('holds for an Antigravity run', async () => {
    expectAllValid(await emitted(['--harness', 'antigravity', '--lifecycle', 'v2'], [
      { args: ['--event', 'PreInvocation'], payload: { conversationId: 'c', invocationNum: 0, modelName: 'gemini-3.8-flash-high', workspacePaths: [] } },
      { args: ['--event', 'PreToolUse'], payload: { conversationId: 'c', toolCall: { name: 'run_command', args: { command: 'npm test' } }, stepIdx: 1, modelName: 'gemini-3.8-flash-high' } },
      { args: ['--event', 'Stop'], payload: { conversationId: 'c', fullyIdle: true, terminationReason: 'NO_TOOL_CALL', modelName: 'gemini-3.8-flash-high' } },
    ]));
  }, 90_000);
});
