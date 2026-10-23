import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdLink } from './link.js';
import { setCredential } from './credentials-store.js';

const BASE_URL = 'https://api.test';
const CRED = { tenant_id: 'tenant-1', api_key: 'aer_secret_key', key_id: 'k1', role: 'write', expires_at: '2099-01-01T00:00:00Z' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('cmdLink', () => {
  let root: string;
  let env: Record<string, string | undefined>;
  let out: string[];
  let err: string[];
  let files: Record<string, string>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aer-link-'));
    env = { HOME: root, XDG_CONFIG_HOME: undefined };
    out = [];
    err = [];
    files = {};
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function deps(overrides: Partial<Parameters<typeof cmdLink>[1]> = {}) {
    return {
      cwd: '/project',
      env,
      defaultBaseUrl: BASE_URL,
      isTTY: false,
      print: (l: string) => out.push(l),
      printErr: (l: string) => err.push(l),
      readFile: (p: string) => files[p] ?? null,
      writeFile: (p: string, c: string) => { files[p] = c; },
      randomUUID: () => '11111111-1111-1111-1111-111111111111',
      ...overrides,
    };
  }

  it('errors when not logged in', async () => {
    const code = await cmdLink({}, deps());
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/aer login/);
  });

  it('non-TTY without --agent or --create-agent is a clear usage error, exit 64', async () => {
    setCredential(BASE_URL, CRED, env);
    const code = await cmdLink({}, deps());
    expect(code).toBe(64);
    expect(err.join('\n')).toMatch(/--agent|--create-agent/);
  });

  it('writes aer.config.json using --agent directly, no network call', async () => {
    setCredential(BASE_URL, CRED, env);
    const fetchImpl = vi.fn();
    const code = await cmdLink({ agentId: 'agent-1' }, deps({ fetchImpl }));
    expect(code).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    const written = JSON.parse(files['/project/aer.config.json']!);
    expect(written).toMatchObject({
      tenant_id: 'tenant-1', agent_id: 'agent-1', env_id: '11111111-1111-1111-1111-111111111111', base_url: BASE_URL,
    });
  });

  it('--create-agent posts to /v1/agents and uses the returned id', async () => {
    setCredential(BASE_URL, CRED, env);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { agent_id: '44444444-4444-4444-4444-444444444444' }));
    const code = await cmdLink({ createAgentName: 'my-agent' }, deps({ fetchImpl }));
    expect(code).toBe(0);
    const written = JSON.parse(files['/project/aer.config.json']!);
    expect(written.agent_id).toBe('44444444-4444-4444-4444-444444444444');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/v1/agents`);
    expect(JSON.parse(init.body as string)).toEqual({ name: 'my-agent' });
  });

  it('never writes the api key into aer.config.json', async () => {
    setCredential(BASE_URL, CRED, env);
    await cmdLink({ agentId: 'agent-1' }, deps());
    const written = files['/project/aer.config.json']!;
    expect(written).not.toContain(CRED.api_key);
  });

  it('preserves unknown existing keys in aer.config.json', async () => {
    setCredential(BASE_URL, CRED, env);
    files['/project/aer.config.json'] = JSON.stringify({ custom_field: 'keep-me', agent_id: 'old-agent' });
    const code = await cmdLink({ agentId: 'agent-1' }, deps());
    expect(code).toBe(0);
    const written = JSON.parse(files['/project/aer.config.json']!);
    expect(written.custom_field).toBe('keep-me');
    expect(written.agent_id).toBe('agent-1');
  });

  it('preserves an existing env_id rather than regenerating it', async () => {
    setCredential(BASE_URL, CRED, env);
    files['/project/aer.config.json'] = JSON.stringify({ env_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
    await cmdLink({ agentId: 'agent-1' }, deps());
    const written = JSON.parse(files['/project/aer.config.json']!);
    expect(written.env_id).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  });

  it('an explicit --env overrides an existing one', async () => {
    setCredential(BASE_URL, CRED, env);
    files['/project/aer.config.json'] = JSON.stringify({ env_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
    await cmdLink({ agentId: 'agent-1', envId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }, deps());
    const written = JSON.parse(files['/project/aer.config.json']!);
    expect(written.env_id).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  });

  it('on a TTY with no --env and no promptEnvName, still falls back to a generated id', async () => {
    setCredential(BASE_URL, CRED, env);
    const code = await cmdLink({ agentId: 'agent-1' }, deps({ isTTY: true }));
    expect(code).toBe(0);
    const written = JSON.parse(files['/project/aer.config.json']!);
    expect(written.env_id).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('on a TTY with promptEnvName wired, lists environments and uses the chosen name', async () => {
    setCredential(BASE_URL, CRED, env);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {
      environments: [{ environment_id: 'laptop', session_count: 4 }, { environment_id: 'ci', session_count: 1 }],
    }));
    const promptEnvName = vi.fn().mockResolvedValue('laptop');
    const code = await cmdLink({ agentId: 'agent-1' }, deps({ isTTY: true, fetchImpl, promptEnvName }));
    expect(code).toBe(0);
    expect(promptEnvName).toHaveBeenCalledWith([{ environment_id: 'laptop', session_count: 4 }, { environment_id: 'ci', session_count: 1 }]);
    const written = JSON.parse(files['/project/aer.config.json']!);
    expect(written.env_id).toBe('laptop');
  });

  it('promptEnvName is never consulted once --env or an existing env_id already answers it', async () => {
    setCredential(BASE_URL, CRED, env);
    const promptEnvName = vi.fn().mockResolvedValue('should-not-be-used');
    await cmdLink({ agentId: 'agent-1', envId: 'explicit-env' }, deps({ isTTY: true, promptEnvName }));
    expect(promptEnvName).not.toHaveBeenCalled();
    files['/project/aer.config.json'] = JSON.stringify({ env_id: 'already-set' });
    await cmdLink({ agentId: 'agent-1' }, deps({ isTTY: true, promptEnvName }));
    expect(promptEnvName).not.toHaveBeenCalled();
  });

  it('a blank name from promptEnvName falls back to the generated id rather than writing an empty env_id', async () => {
    setCredential(BASE_URL, CRED, env);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { environments: [] }));
    const promptEnvName = vi.fn().mockResolvedValue('   ');
    const code = await cmdLink({ agentId: 'agent-1' }, deps({ isTTY: true, fetchImpl, promptEnvName }));
    expect(code).toBe(0);
    const written = JSON.parse(files['/project/aer.config.json']!);
    expect(written.env_id).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('a failed environments fetch still prompts, with an empty list rather than failing the link', async () => {
    setCredential(BASE_URL, CRED, env);
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    const promptEnvName = vi.fn().mockResolvedValue('new-box');
    const code = await cmdLink({ agentId: 'agent-1' }, deps({ isTTY: true, fetchImpl, promptEnvName }));
    expect(code).toBe(0);
    expect(promptEnvName).toHaveBeenCalledWith([]);
    const written = JSON.parse(files['/project/aer.config.json']!);
    expect(written.env_id).toBe('new-box');
  });

  it('a non-TTY run never consults promptEnvName even if one is wired', async () => {
    setCredential(BASE_URL, CRED, env);
    const promptEnvName = vi.fn().mockResolvedValue('should-not-run');
    const code = await cmdLink({ agentId: 'agent-1' }, deps({ isTTY: false, promptEnvName }));
    expect(code).toBe(0);
    expect(promptEnvName).not.toHaveBeenCalled();
    const written = JSON.parse(files['/project/aer.config.json']!);
    expect(written.env_id).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('promptEnvName rejecting fails the link cleanly, exit 1, no orphan agent created', async () => {
    setCredential(BASE_URL, CRED, env);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { environments: [] }));
    const promptEnvName = vi.fn().mockRejectedValue(new Error('stdin closed'));
    const code = await cmdLink({ createAgentName: 'should-not-be-created' }, deps({ isTTY: true, fetchImpl, promptEnvName }));
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/stdin closed/);
    expect(fetchImpl).not.toHaveBeenCalledWith(expect.stringContaining('/v1/agents'), expect.anything());
    expect(files['/project/aer.config.json']).toBeUndefined();
  });

  it('on a TTY without flags, lists agents and uses the picked one', async () => {
    setCredential(BASE_URL, CRED, env);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {
      agents: [{ agent_id: 'agent-a', name: 'A' }, { agent_id: 'agent-b', name: 'B' }],
    }));
    const promptChoice = vi.fn().mockResolvedValue(1);
    const code = await cmdLink({}, deps({ isTTY: true, fetchImpl, promptChoice }));
    expect(code).toBe(0);
    expect(promptChoice).toHaveBeenCalledWith([{ agent_id: 'agent-a', name: 'A' }, { agent_id: 'agent-b', name: 'B' }]);
    const written = JSON.parse(files['/project/aer.config.json']!);
    expect(written.agent_id).toBe('agent-b');
  });

  it('on a TTY with no agents, tells the user to --create-agent instead of picking nothing', async () => {
    setCredential(BASE_URL, CRED, env);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { agents: [] }));
    const code = await cmdLink({}, deps({ isTTY: true, fetchImpl }));
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/--create-agent/);
  });

  it('P2-5: an error body from --create-agent is capped and cleaned before printing', async () => {
    setCredential(BASE_URL, CRED, env);
    const huge = `\x07${'y'.repeat(5000)}`;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(huge, { status: 500 }));
    const code = await cmdLink({ createAgentName: 'x' }, deps({ fetchImpl }));
    expect(code).toBe(1);
    const message = err.join('\n');
    expect(message.length).toBeLessThan(500);
    expect(message).not.toMatch(/[\x00-\x08\x0B-\x1F\x7F]/);
  });

  it('P3: refuses a create-agent response whose agent_id is not a UUID', async () => {
    setCredential(BASE_URL, CRED, env);
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { agent_id: 'not-a-uuid' }));
    const code = await cmdLink({ createAgentName: 'x' }, deps({ fetchImpl }));
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/agent_id/);
  });

  // CVE-2026-111497: fetch() decodes a Brotli body lazily on first read, and a
  // hostile or misconfigured base_url picks Content-Encoding regardless of
  // what was requested. Garbage bytes rather than real Brotli, so an
  // unguarded read would fail on JSON.parse with a DIFFERENT message than the
  // CVE refusal, proving the guard (not a parse failure) is what rejected it.
  it('refuses a compressed agent-list response without reading its body', async () => {
    setCredential(BASE_URL, CRED, env);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-encoding': 'br' } }),
      );
    const code = await cmdLink({}, deps({ isTTY: true, fetchImpl }));
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/CVE-2026-111497/);
  });

  it('refuses a compressed create-agent error response without reading its body', async () => {
    setCredential(BASE_URL, CRED, env);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), { status: 500, headers: { 'content-encoding': 'br' } }),
      );
    const code = await cmdLink({ createAgentName: 'x' }, deps({ fetchImpl }));
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/CVE-2026-111497/);
  });
});
