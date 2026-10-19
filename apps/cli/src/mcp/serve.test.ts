import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { setCredential } from '../auth/credentials-store.js';
import { runMcpServe } from './serve.js';

const BASE = 'http://test.local';

const mswServer = setupServer(
  http.get(`${BASE}/v1/tenant/settings`, () => HttpResponse.json({ mcp_access_enabled: true })),
);

beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

function deps(overrides: Partial<Parameters<typeof runMcpServe>[1]> = {}) {
  const errs: string[] = [];
  return {
    env: { HOME: root, XDG_CONFIG_HOME: undefined } as Record<string, string | undefined>,
    defaultBaseUrl: BASE,
    cliVersion: '9.9.9',
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    printErr: (l: string) => errs.push(l),
    errs,
    ...overrides,
  };
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aer-mcp-serve-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('runMcpServe pre-flight', () => {
  it('exits 2 with no credential and no env key', async () => {
    const d = deps();
    const code = await runMcpServe({}, d);
    expect(code).toBe(2);
    expect(d.errs.join(' ')).toContain('aer login');
  });

  it('refuses to start with a stored admin-role key unless --allow-admin-key', async () => {
    setCredential(BASE, { tenant_id: 't1', api_key: 'aer_admin_key', key_id: 'k1', role: 'admin', expires_at: '2099-01-01T00:00:00Z' }, { HOME: root, XDG_CONFIG_HOME: undefined });
    const d = deps();
    const code = await runMcpServe({}, d);
    expect(code).toBe(1);
    expect(d.errs.join(' ')).toContain('admin-role key');
  });

  it('starts with an admin-role key when --allow-admin-key is passed', async () => {
    setCredential(BASE, { tenant_id: 't1', api_key: 'aer_admin_key', key_id: 'k1', role: 'admin', expires_at: '2099-01-01T00:00:00Z' }, { HOME: root, XDG_CONFIG_HOME: undefined });
    const d = deps();
    (d.stdin as PassThrough).end(); // nothing to serve; immediately closes the loop
    const code = await runMcpServe({ allowAdminKey: true }, d);
    expect(code).toBe(0);
  });

  it('starts fine with a stored read-role key', async () => {
    setCredential(BASE, { tenant_id: 't1', api_key: 'aer_read_key', key_id: 'k1', role: 'read', expires_at: '2099-01-01T00:00:00Z' }, { HOME: root, XDG_CONFIG_HOME: undefined });
    const d = deps();
    (d.stdin as PassThrough).end();
    const code = await runMcpServe({}, d);
    expect(code).toBe(0);
  });

  it('exits 3 when the tenant has not enabled copilot access, naming the Settings card', async () => {
    mswServer.use(http.get(`${BASE}/v1/tenant/settings`, () => HttpResponse.json({ mcp_access_enabled: false })));
    setCredential(BASE, { tenant_id: 't1', api_key: 'aer_read_key', key_id: 'k1', role: 'read', expires_at: '2099-01-01T00:00:00Z' }, { HOME: root, XDG_CONFIG_HOME: undefined });
    const d = deps();
    const code = await runMcpServe({}, d);
    expect(code).toBe(3);
    expect(d.errs.join(' ')).toContain('turned off');
  });

  it('exits 3 when the API itself refuses with mcp_access_disabled (header-based refusal)', async () => {
    mswServer.use(http.get(`${BASE}/v1/tenant/settings`, () => HttpResponse.json({ error: 'mcp_access_disabled' }, { status: 403 })));
    setCredential(BASE, { tenant_id: 't1', api_key: 'aer_read_key', key_id: 'k1', role: 'read', expires_at: '2099-01-01T00:00:00Z' }, { HOME: root, XDG_CONFIG_HOME: undefined });
    const d = deps();
    const code = await runMcpServe({}, d);
    expect(code).toBe(3);
  });

  it('exits 1 with stale/expired stored credentials', async () => {
    setCredential(BASE, { tenant_id: 't1', api_key: 'aer_read_key', key_id: 'k1', role: 'read', expires_at: '2000-01-01T00:00:00Z' }, { HOME: root, XDG_CONFIG_HOME: undefined });
    const d = deps();
    const code = await runMcpServe({}, d);
    expect(code).toBe(1);
    expect(d.errs.join(' ')).toContain('expired');
  });

  it('never prints the API key in any diagnostic', async () => {
    setCredential(BASE, { tenant_id: 't1', api_key: 'aer_super_secret_do_not_leak', key_id: 'k1', role: 'admin', expires_at: '2099-01-01T00:00:00Z' }, { HOME: root, XDG_CONFIG_HOME: undefined });
    const d = deps();
    await runMcpServe({}, d);
    expect(d.errs.join(' ')).not.toContain('aer_super_secret_do_not_leak');
  });
});

describe('runMcpServe end to end over stdio', () => {
  it('answers an initialize request written to stdin on stdout, newline-delimited', async () => {
    setCredential(BASE, { tenant_id: 't1', api_key: 'aer_read_key', key_id: 'k1', role: 'read', expires_at: '2099-01-01T00:00:00Z' }, { HOME: root, XDG_CONFIG_HOME: undefined });
    const out: string[] = [];
    const d = deps({ onWrite: (l: string) => out.push(l) } as never);
    const stdin = d.stdin as PassThrough;
    const donePromise = runMcpServe({}, d);
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
    stdin.end();
    const code = await donePromise;
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]) as { result: { serverInfo: { name: string } } };
    expect(parsed.result.serverInfo.name).toBe('aer-oversight');
  });
});
