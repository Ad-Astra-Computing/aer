// The site says AER works with Claude Code, Codex CLI and Antigravity. Those
// binaries cannot run here, so the claim is held to what can be checked: the
// config the installer writes is validated against the harness's own
// published schema, and the hook binary is driven the way a harness drives it.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Ajv from 'ajv';
import { execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cleanEnv } from './env.js';
import { distProblem } from '../../../scripts/require-dist.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const hooksDist = join(here, '..', '..', 'aer-hooks', 'dist');
const installCli = join(hooksDist, 'install-cli.js');
const hookCli = join(hooksDist, 'cli.js');

const schema: unknown = JSON.parse(
  readFileSync(join(here, 'schemas', 'claude-code-settings.schema.json'), 'utf8'),
);

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'aer-harness-'));
  dirs.push(d);
  return d;
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

let api: Server;
let baseUrl: string;
let posted: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  const problem = distProblem(join(hooksDist, '..'));
  if (problem) throw new Error(problem);
  api = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/sessions') {
        res.statusCode = 201;
        res.end(JSON.stringify({
          agent_session_id: '01950000-0000-7000-8000-00000000aaaa',
          ingest_token: 'ingest-token',
        }));
        return;
      }
      try {
        const parsed: unknown = JSON.parse(body);
        if (Array.isArray(parsed)) posted.push(...(parsed as Array<Record<string, unknown>>));
      } catch { /* not an event batch */ }
      res.statusCode = 202;
      res.end(JSON.stringify({ accepted: 1 }));
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(async () => { await new Promise((r) => api.close(() => r(null))); });

function install(harness: string, dir: string): void {
  execFileSync(process.execPath, [installCli, 'install', harness, '--dir', dir], {
    encoding: 'utf8', stdio: 'pipe', env: cleanEnv({}),
  });
}

describe('the config AER writes is one Claude Code accepts', () => {
  // SchemaStore rather than Anthropic, so this is evidence about the format
  // and not a promise from the vendor. It still catches the case that matters:
  // we keep writing a shape the harness has stopped taking.
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validate = ajv.compile(schema as object);

  it('validates against the published settings schema', () => {
    const dir = scratch();
    install('claude-code', dir);
    const settings: unknown = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
    const ok = validate(settings);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('still validates after uninstall', () => {
    const dir = scratch();
    install('claude-code', dir);
    execFileSync(process.execPath, [installCli, 'uninstall', 'claude-code', '--dir', dir], {
      encoding: 'utf8', stdio: 'pipe', env: cleanEnv({}),
    });
    const settings: unknown = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
    expect(validate(settings)).toBe(true);
  });

  it('would reject an event name the harness does not have', () => {
    // Proves the schema is doing work: the hooks object refuses unknown keys,
    // so a typo or a removed event fails here rather than at a customer.
    expect(validate({ hooks: { NotARealEvent: [{ hooks: [{ type: 'command', command: 'x' }] }] } }))
      .toBe(false);
  });

  it('registers only events the schema knows', () => {
    const dir = scratch();
    install('claude-code', dir);
    const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')) as {
      hooks: Record<string, unknown>;
    };
    const known = Object.keys(
      ((schema as Record<string, Record<string, Record<string, Record<string, unknown>>>>)
        ['properties']?.['hooks']?.['properties']) ?? {},
    );
    expect(Object.keys(settings.hooks).length).toBeGreaterThan(0);
    for (const event of Object.keys(settings.hooks)) expect(known).toContain(event);
  });
});

describe('the hook binary, run the way a harness runs it', () => {
  function hookEnv(base: string): NodeJS.ProcessEnv {
    return cleanEnv({
      AER_BASE_URL: base,
      AER_API_KEY: 'not-a-real-key',
      AER_TENANT_ID: '01950000-0000-7000-8000-000000000001',
      AER_AGENT_ID: '01950000-0000-7000-8000-000000000002',
      AER_ENV_ID: '01950000-0000-7000-8000-000000000003',
      AER_HOOK_TIMEOUT_MS: '5000',
      XDG_CACHE_HOME: scratch(),
    });
  }

  // The harness pipes the payload and closes the stream, which is what this
  // does. spawnSync's `input` leaves the hook waiting on stdin for its whole
  // timeout, so it would test the timeout path and nothing else.
  async function fire(
    payload: unknown,
    args: string[] = [],
    base = baseUrl,
  ): Promise<{ status: number; stdout: string; stderr: string }> {
    const child = spawn(process.execPath, [hookCli, ...args], {
      env: hookEnv(base), stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { stdout += d; });
    child.stderr.on('data', (d: string) => { stderr += d; });
    child.stdin.end(JSON.stringify(payload));
    const status = await new Promise<number>((r) => child.on('exit', (c) => r(c ?? -1)));
    return { status, stdout, stderr };
  }

  // Field names as each harness documents them. Claude Code and Codex send
  // hook_event_name in the payload; Antigravity names the event on argv.
  const cases: Array<{ label: string; payload: Record<string, unknown>; args?: string[]; tool: string }> = [
    {
      label: 'Claude Code PreToolUse',
      payload: {
        session_id: 'ses_cc', hook_event_name: 'PreToolUse', tool_name: 'Bash',
        tool_input: { command: 'cat /etc/SECRET-FILE', description: 'read' },
      },
      tool: 'Bash',
    },
    {
      label: 'Codex PreToolUse',
      payload: {
        session_id: 'ses_cx', turn_id: 'turn_1', tool_use_id: 'tu_1',
        hook_event_name: 'PreToolUse', tool_name: 'shell',
        tool_input: { command: 'cat /etc/SECRET-FILE' },
      },
      tool: 'shell',
    },
    {
      label: 'Antigravity PreToolUse',
      payload: {
        conversationId: 'conv_1', stepIdx: 2,
        toolCall: { name: 'run_command', args: { command: 'cat /etc/SECRET-FILE' } },
      },
      args: ['--harness', 'antigravity', '--event', 'PreToolUse'],
      tool: 'run_command',
    },
  ];

  for (const { label, payload, args, tool } of cases) {
    it(`records ${label} as a tool event, key names only`, async () => {
      posted = [];
      const res = await fire(payload, args);
      expect(res.status).toBe(0);
      // A hook that writes to stdout corrupts the harness's own protocol.
      expect(res.stdout).toBe('');

      const started = posted.find((e) => e['event_type'] === 'tool.started');
      const p = (started?.['payload'] ?? {}) as Record<string, unknown>;
      expect(p['tool']).toBe(tool);
      expect(p['arg_keys']).toContain('command');
      expect(JSON.stringify(posted)).not.toContain('/etc/SECRET-FILE');
    });
  }

  it('exits 0 and stays silent when AER is unreachable', async () => {
    // The promise the README makes: a hook that cannot reach AER never blocks
    // a tool call.
    const res = await fire(
      { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} },
      [],
      'http://127.0.0.1:1',
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  });

  it('exits 0 and stays silent on a payload it cannot read', async () => {
    for (const input of ['', 'not json', '[]', 'null', '{"unexpected":true}']) {
      const child = spawn(process.execPath, [hookCli], { env: hookEnv(baseUrl), stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => { stdout += d; });
      child.stdin.end(input);
      const status = await new Promise<number>((r) => child.on('exit', (c) => r(c ?? -1)));
      expect(status).toBe(0);
      expect(stdout).toBe('');
    }
  });
});
