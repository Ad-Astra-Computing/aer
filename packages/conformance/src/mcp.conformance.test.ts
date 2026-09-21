// The site says AER works with MCP servers. The recorder's own tests feed it
// JSON-RPC frames we wrote; this runs a real server built with the vendor SDK
// behind the real recorder binary, with a real client, and reads what AER
// posted. Everything is local: the API is a loopback server.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cleanEnv } from './env.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const recorderCli = join(here, '..', '..', 'aer-mcp-recorder', 'dist', 'cli.js');

interface Posted { url: string; body: unknown }

let api: Server;
let baseUrl: string;
const posts: Posted[] = [];

beforeAll(async () => {
  api = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      posts.push({ url: req.url ?? '', body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/sessions') {
        res.statusCode = 201;
        res.end(JSON.stringify({
          agent_session_id: '01950000-0000-7000-8000-00000000aaaa',
          ingest_token: 'ingest-token',
        }));
        return;
      }
      res.end(JSON.stringify({ accepted: 1 }));
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => api.close(() => r(null)));
});

/** Drive a real client through the recorder into a real server. */
async function session(): Promise<{ stdout: string; events: Array<Record<string, unknown>> }> {
  const env = cleanEnv({
    AER_BASE_URL: baseUrl,
    AER_API_KEY: 'not-a-real-key',
    AER_TENANT_ID: '01950000-0000-7000-8000-000000000001',
    AER_AGENT_ID: '01950000-0000-7000-8000-000000000002',
    AER_ENV_ID: '01950000-0000-7000-8000-000000000003',
  });
  const child = spawn(
    process.execPath,
    [
      join(fixtures, 'mcp-client.mjs'),
      process.execPath, recorderCli, '--', process.execPath, join(fixtures, 'mcp-server.mjs'),
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: fixtures },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += String(d)));
  child.stderr.on('data', (d) => (stderr += String(d)));
  const code = await new Promise<number>((r) => child.on('exit', (c) => r(c ?? -1)));
  if (code !== 0) throw new Error(`client exited ${code}: ${stderr}`);
  // The recorder posts on close, just after the client's own exit.
  await new Promise((r) => setTimeout(r, 500));

  const events = posts
    .filter((p) => Array.isArray(p.body))
    .flatMap((p) => p.body as Array<Record<string, unknown>>);
  return { stdout, events };
}

describe('a real MCP server behind the real recorder', () => {
  it('records the handshake, the tool list and the call', async () => {
    const { stdout, events } = await session();

    // The proxy is transparent: the client still got its real answer.
    expect(stdout).toContain('CALL-OK:"RESULT-BODY-FOR-CUST-42"');

    const types = events.map((e) => e['event_type']);
    expect(types).toContain('mcp.initialize');
    expect(types).toContain('mcp.tools.list');
    expect(types).toContain('tool.started');
    expect(types).toContain('tool.completed');
    expect(types).toContain('mcp.recorder.report');

    const payload = (t: string): Record<string, unknown> =>
      (events.find((e) => e['event_type'] === t)?.['payload'] ?? {}) as Record<string, unknown>;

    // A protocol version the SDK negotiated, not one we invented.
    expect(String(payload('mcp.initialize')['protocol_version'])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(payload('mcp.initialize')['client_name']).toBe('conformance-client');
    expect(payload('mcp.tools.list')['tools']).toEqual(['lookup_customer', 'always_fails']);
    expect(payload('tool.started')['tool']).toBe('lookup_customer');
    expect(payload('tool.completed')['ok']).toBe(true);
    expect(payload('mcp.recorder.report')['server']).toMatchObject({
      name: 'conformance-server',
      version: '9.9.9',
    });
  });

  it('records argument key names and never the values or the result', async () => {
    const { events } = await session();
    const started = events.find((e) => e['event_type'] === 'tool.started');
    expect((started?.['payload'] as Record<string, unknown>)['arg_keys']).toEqual(['customer_id']);

    const json = JSON.stringify(events);
    expect(json).toContain('customer_id');     // the key is metadata
    expect(json).not.toContain('CUST-42');     // the value is not
    expect(json).not.toContain('RESULT-BODY'); // nor is the result
    expect(json).not.toContain('not-a-real-key');
  });
});
