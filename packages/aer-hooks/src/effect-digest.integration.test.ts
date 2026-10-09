// End-to-end: the real cli.ts hook flow (PreToolUse then PostToolUse, as two
// separate invocations) pairs a before/after file-content digest through
// runHook, against a FakeApi standing in for the server.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runHook } from './cli.js';
import { FakeApi } from './fake-api.test-support.js';

const V2 = ['--harness', 'claude-code', '--lifecycle', 'v2'];
const KEY_HEX = '01'.repeat(32);

let cacheDir: string;
// The simulated project workspace lives under $HOME, never under the OS
// tmpdir (which itself classifies as PathClass 'tmp') or this real git
// worktree (whose real .git would otherwise be found by the workspace walk).
let workspaceDir: string;
let api: FakeApi;

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    AER_API_KEY: 'k', AER_TENANT_ID: 't', AER_AGENT_ID: 'agent-1',
    AER_ENV_ID: '01950000-0000-7000-8000-0000000000ad',
    AER_BASE_URL: 'http://aer.test',
    XDG_CACHE_HOME: cacheDir, TMPDIR: path.join(cacheDir, 'tmp'),
    HOME: path.join(cacheDir, 'home'),
    AER_COMMITMENT_KEY: KEY_HEX,
    ...extra,
  } as NodeJS.ProcessEnv;
}

function fire(payload: Record<string, unknown>): Promise<void> {
  return runHook(V2, env(), { readInput: async () => JSON.stringify(payload), fetch: api.fetch });
}

beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aer-effect-digest-it-cache-'));
  fs.mkdirSync(path.join(cacheDir, 'tmp'));
  workspaceDir = fs.mkdtempSync(path.join(os.homedir(), '.aer-effect-digest-it-ws-'));
  api = new FakeApi();
});

afterEach(() => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

describe('effects recording: tool_start/tool_end pairing through the real hook flow', () => {
  it('emits one combined file.written with sha256_before/after for a modified existing file', async () => {
    const filePath = path.join(workspaceDir, 'notes.md');
    fs.writeFileSync(filePath, 'before content');
    const base = { session_id: 'cc-1', cwd: workspaceDir, tool_name: 'Write', tool_input: { file_path: filePath }, tool_use_id: 'tu1' };

    await fire({ ...base, hook_event_name: 'PreToolUse' });
    // The file.written shape for a hashable path is withheld at tool_start,
    // stashed instead; nothing yet on the wire for this path.
    expect(api.eventsOf('file.written')).toHaveLength(0);

    fs.writeFileSync(filePath, 'after content'); // simulate the tool actually writing
    await fire({ ...base, hook_event_name: 'PostToolUse', tool_response: { is_error: false } });

    const written = api.eventsOf('file.written');
    expect(written).toHaveLength(1);
    expect(written[0]!.payload).toMatchObject({ path: filePath, hash_status: 'ok' });
    expect(written[0]!.payload['sha256_before']).toMatch(/^[0-9a-f]{64}$/);
    expect(written[0]!.payload['sha256_after']).toMatch(/^[0-9a-f]{64}$/);
    expect(written[0]!.payload['sha256_before']).not.toBe(written[0]!.payload['sha256_after']);
    expect(written[0]!.payload['kid']).toMatch(/^[0-9a-f]{16}$/);
    expect(written[0]!.payload['bytes']).toBe('after content'.length);
  });

  it('emits no sha256_before for a brand-new file', async () => {
    const filePath = path.join(workspaceDir, 'new.md');
    const base = { session_id: 'cc-2', cwd: workspaceDir, tool_name: 'Write', tool_input: { file_path: filePath }, tool_use_id: 'tu1' };

    await fire({ ...base, hook_event_name: 'PreToolUse' });
    fs.writeFileSync(filePath, 'brand new');
    await fire({ ...base, hook_event_name: 'PostToolUse', tool_response: { is_error: false } });

    const written = api.eventsOf('file.written');
    expect(written).toHaveLength(1);
    expect(written[0]!.payload['sha256_before']).toBeUndefined();
    expect(written[0]!.payload['sha256_after']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never computes a digest for a credential-class path, keeping the bare marker at tool_start', async () => {
    const filePath = path.join(workspaceDir, '.env.local');
    const base = { session_id: 'cc-3', cwd: workspaceDir, tool_name: 'Write', tool_input: { file_path: filePath }, tool_use_id: 'tu1' };

    await fire({ ...base, hook_event_name: 'PreToolUse' });
    const written = api.eventsOf('file.written');
    expect(written).toHaveLength(1);
    expect(written[0]!.payload).toMatchObject({ path: filePath, tool: 'Write' });
    expect(written[0]!.payload['sha256_after']).toBeUndefined();
    expect(written[0]!.payload['hash_status']).toBeUndefined();

    fs.writeFileSync(filePath, 'SECRET=1');
    await fire({ ...base, hook_event_name: 'PostToolUse', tool_response: { is_error: false } });
    expect(api.eventsOf('file.written')).toHaveLength(1); // still just the one, no digest row added
  });

  it('never computes a digest without a configured commitment key', async () => {
    const filePath = path.join(workspaceDir, 'notes.md');
    fs.writeFileSync(filePath, 'before');
    const base = { session_id: 'cc-4', cwd: workspaceDir, tool_name: 'Write', tool_input: { file_path: filePath }, tool_use_id: 'tu1' };
    const noKeyEnv = env({ AER_COMMITMENT_KEY: undefined });

    await runHook(V2, noKeyEnv, { readInput: async () => JSON.stringify({ ...base, hook_event_name: 'PreToolUse' }), fetch: api.fetch });
    fs.writeFileSync(filePath, 'after');
    await runHook(V2, noKeyEnv, { readInput: async () => JSON.stringify({ ...base, hook_event_name: 'PostToolUse', tool_response: { is_error: false } }), fetch: api.fetch });

    const written = api.eventsOf('file.written');
    expect(written).toHaveLength(1);
    expect(written[0]!.payload).toMatchObject({ path: filePath, tool: 'Write' });
    expect(written[0]!.payload['sha256_after']).toBeUndefined();
    expect(written[0]!.payload['hash_status']).toBeUndefined();
  });
});
