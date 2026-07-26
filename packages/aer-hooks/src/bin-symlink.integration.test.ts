import { it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression this test pins: both aer-hooks bins (`aer-hook` -> dist/cli.js, `aer-hooks`
// -> dist/install-cli.js) are invoked through node_modules/.bin symlinks whose
// names never matched the old endsWith() guards, so `install`/`uninstall` and
// every hook event were silent no-ops. Import-based tests missed it. This test
// EXECUTES the installer bin through a real symlink and proves it actually runs.

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkgRoot, '../..');
const distInstall = join(pkgRoot, 'dist', 'install-cli.js');

beforeAll(() => {
  const tsc = join(repoRoot, 'node_modules', '.bin', 'tsc');
  execFileSync(tsc, ['-p', 'tsconfig.json'], { cwd: pkgRoot, stdio: 'ignore' });
}, 60_000);

it('runs the installer bin (prints usage) when invoked through a .bin symlink', () => {
  expect(existsSync(distInstall)).toBe(true);

  // node_modules/.bin/aer-hooks -> dist/install-cli.js, exactly as npm wires it.
  const dir = mkdtempSync(join(tmpdir(), 'aer-hooks-binlink-'));
  const binDir = join(dir, '.bin');
  mkdirSync(binDir);
  const link = join(binDir, 'aer-hooks');
  symlinkSync(distInstall, link);

  // No args prints usage and exits 0. Before the fix this produced no output.
  const out = execFileSync(process.execPath, [link], { encoding: 'utf8', timeout: 20_000 });
  expect(out.toLowerCase()).toContain('usage');
});
