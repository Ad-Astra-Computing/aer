import { it, expect, beforeAll, describe } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The README promises the built hook never breaks a harness: it exits 0 on
// every path and never writes to stdout, whatever the API does. That promise
// was only tested in process. This runs the actual built binary, the way
// Claude Code runs it, over every harness event, and holds it there.

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkgRoot, '../..');
const hookBin = join(pkgRoot, 'dist', 'cli.js');

beforeAll(() => {
  const tsc = join(repoRoot, 'node_modules', '.bin', 'tsc');
  execFileSync(tsc, ['-p', 'tsconfig.json'], { cwd: pkgRoot, stdio: 'ignore' });
}, 60_000);

// Port 9 refuses at once, so the hook fails its network call immediately rather
// than sitting on its timeout. That keeps the fail-open promise the point of
// the test, not the sink's retry budget.
function runHook(eventName: string): { status: number | null; stdout: string; stderr: string } {
  const cache = mkdtempSync(join(tmpdir(), 'aer-hook-cache-'));
  const event = {
    session_id: 'harness-session-1',
    hook_event_name: eventName,
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_response: { stdout: 'x' },
    source: 'startup',
    last_assistant_message: 'done',
    cwd: '/tmp',
  };
  const r = spawnSync(process.execPath, [hookBin, '--harness', 'claude-code'], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      AER_BASE_URL: 'http://127.0.0.1:9',
      AER_API_KEY: 'aer_probe',
      AER_TENANT_ID: '01950000-0000-7000-8000-0000000000aa',
      AER_AGENT_ID: '01950000-0000-7000-8000-0000000000ac',
      AER_ENV_ID: '01950000-0000-7000-8000-0000000000ad',
      AER_HOOK_TIMEOUT_MS: '4000',
      XDG_CACHE_HOME: cache,
    },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('the built aer-hook binary', () => {
  it.each(['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit'])(
    'exits 0 and writes nothing to stdout on %s, even when the API is unreachable',
    (eventName) => {
      const r = runHook(eventName);
      expect(r.status, `${eventName} exit code; stderr: ${r.stderr}`).toBe(0);
      expect(r.stdout, `${eventName} wrote to stdout`).toBe('');
    },
  );
});
