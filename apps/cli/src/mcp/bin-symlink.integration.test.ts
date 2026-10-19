// `aer mcp serve` must answer the MCP protocol through a real .bin symlink
// and a real child process, not just through `main()` imported in-process
// (see entrypoint.test.ts's header for why that distinction matters).

import { it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { distProblem } from '../../../../scripts/require-dist.mjs';

const pkgRoot = resolve(import.meta.dirname, '../..');
const distMain = join(pkgRoot, 'dist', 'main.js');

let apiServer: Server;
let baseUrl: string;

beforeAll(async () => {
  const problem = distProblem(pkgRoot);
  if (problem) throw new Error(problem);

  apiServer = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/v1/tenant/settings')) {
      res.end(JSON.stringify({ mcp_access_enabled: true, tenant_id: 'tenant-bin-test' }));
      return;
    }
    if (req.url?.startsWith('/v1/agents')) {
      res.end(JSON.stringify({ agents: [{ agent_id: 'agent-1', name: 'Bin Test Agent', status: 'active' }], next_cursor: null }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  const addr = apiServer.address();
  if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => apiServer.close(() => resolve()));
});

it('answers initialize and tools/call list_agents through a .bin symlink, piping stdio to a real process', async () => {
  expect(existsSync(distMain)).toBe(true);

  const dir = mkdtempSync(join(tmpdir(), 'aer-mcp-binlink-'));
  const binDir = join(dir, '.bin');
  mkdirSync(binDir);
  const link = join(binDir, 'aer');
  symlinkSync(distMain, link);

  // Strip every inherited AER_* so this test's assertions reflect only what
  // it itself configures, never a stray value from the host's own `aer
  // login`/aer.config.json (an agent's tool shell in particular can carry
  // real production settings; see AGENTS.md "Working in someone else's
  // repository").
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AER_')));
  const child = spawn(link, ['mcp', 'serve'], {
    env: {
      ...cleanEnv,
      AER_BASE_URL: baseUrl,
      AER_TENANT_API_KEY: 'aer_bin_test_key',
      AER_TENANT_ID: 'tenant-bin-test',
      PATH: process.env['PATH'] ?? '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const lines: string[] = [];
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let idx = buffer.indexOf('\n');
    while (idx !== -1) {
      lines.push(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf('\n');
    }
  });

  const waitForLines = (count: number, timeoutMs = 10_000): Promise<void> =>
    new Promise((resolveWait, rejectWait) => {
      const start = Date.now();
      const check = (): void => {
        if (lines.length >= count) return resolveWait();
        if (Date.now() - start > timeoutMs) return rejectWait(new Error(`timed out waiting for ${count} line(s), got ${lines.length}`));
        setTimeout(check, 50);
      };
      check();
    });

  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
    await waitForLines(1);
    const init = JSON.parse(lines[0]) as { result: { serverInfo: { name: string }; instructions: string } };
    expect(init.result.serverInfo.name).toBe('aer-oversight');
    expect(init.result.instructions).toContain('tenant-bin-test');

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_agents', arguments: {} } }) + '\n');
    await waitForLines(2);
    const toolResult = JSON.parse(lines[1]) as { result: { structuredContent: { agents: { agent_id: string }[] } } };
    expect(toolResult.result.structuredContent.agents).toEqual([{ agent_id: 'agent-1', name: 'Bin Test Agent', status: 'active' }]);
  } finally {
    child.stdin.end();
    child.kill();
  }
}, 20_000);
