import { it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression this test pins: the published bin is invoked through a
// node_modules/.bin symlink, and the old entry guard never fired, so the wrapper
// was a silent no-op that also killed the wrapped MCP server. Import-based tests
// missed it entirely. This test EXECUTES the built bin through a real symlink and
// proves byte transparency end to end.

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distCli = join(pkgRoot, 'dist', 'cli.js');

// Tests never build. A sibling file spawning this dist would load it half
// written, so dist comes from one build that finishes before any test runs.
beforeAll(() => {
  if (!existsSync(distCli)) throw new Error('dist is missing: run pnpm -r build first');
});

it('forwards stdin to the wrapped command when invoked through a .bin symlink', () => {
  expect(existsSync(distCli)).toBe(true);

  // Build the exact shape npm creates: node_modules/.bin/<name> -> dist/cli.js.
  const dir = mkdtempSync(join(tmpdir(), 'aer-mcp-binlink-'));
  const binDir = join(dir, '.bin');
  mkdirSync(binDir);
  const link = join(binDir, 'aer-mcp-recorder');
  symlinkSync(distCli, link);

  // No AER_* env: the recorder is unconfigured, so the proxy must forward bytes
  // and record nothing. `cat` echoes stdin, so a working wrapper returns it.
  const out = execFileSync(process.execPath, [link, '--', 'cat'], {
    input: 'hello-through-symlink\n',
    encoding: 'utf8',
    timeout: 20_000,
  });

  expect(out).toContain('hello-through-symlink');
});
