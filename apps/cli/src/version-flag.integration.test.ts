import { it, expect, beforeAll, afterEach, describe } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distProblem } from '../../../scripts/require-dist.mjs';

// Every binary has to be able to say what version it is. It is the first thing
// asked when a record looks wrong, and a CLI that cannot answer it leaves a
// support conversation with nothing to go on. Asserted by EXECUTING the bin: an
// import-level test cannot see argv handling at all, which is how a release of
// the sibling package went out without it.

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as {
  version: string;
  bin: Record<string, string>;
};

// dist/main.js is the package's own bundle, not a tsc artifact, which would
// never self-invoke. Tests never build it: a sibling file spawning it would
// load it half written, so `pnpm test` and CI build once beforehand.
beforeAll(() => {
  const problem = distProblem(pkgRoot);
  if (problem) throw new Error(problem);
});

function run(entry: string, args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [join(pkgRoot, entry), ...args], {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AER_BASE_URL: '', AER_TENANT_API_KEY: '' },
    });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: (err.stdout ?? '') + (err.stderr ?? ''), code: err.status ?? 1 };
  }
}

describe.each(Object.entries(manifest.bin))('%s --version', (_name, entry) => {
  it('prints the package version and exits 0', () => {
    const r = run(entry, ['--version']);
    expect(r.out.trim()).toContain(manifest.version);
    expect(r.code).toBe(0);
  });

  it('answers -V the same way, since both spellings are reached for', () => {
    expect(run(entry, ['-V']).out.trim()).toContain(manifest.version);
  });

  // The version has to come from the manifest a release bumps. A literal in the
  // source names the previous release forever and nobody notices.
  it('reports the version the manifest carries, not a restated constant', () => {
    expect(run(entry, ['--version']).out.trim()).toBe(manifest.version);
  });

  it('answers --version before it could reach the network or write a file', () => {
    // No base URL, no key, no subcommand: anything that tried to do real work
    // here would fail, so a clean version means it short-circuited.
    expect(run(entry, ['--version']).code).toBe(0);
  });

  it('still rejects a flag it does not know, so --version is not a catch-all', () => {
    expect(run(entry, ['--definitely-not-a-flag']).code).not.toBe(0);
  });
});

// The nix flake's `aer` app copies only the built entry file, with no
// package.json alongside it, unlike the npm install layout.
describe('aer --version away from its own package.json', () => {
  let scratchDir: string;

  afterEach(() => {
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  });

  it('still reports the real version, mirroring the flake app layout', () => {
    scratchDir = mkdtempSync(join(tmpdir(), 'aer-cli-no-manifest-'));
    const copy = join(scratchDir, 'main.js');
    copyFileSync(join(pkgRoot, 'dist/main.js'), copy);
    const out = execFileSync(process.execPath, [copy, '--version'], {
      encoding: 'utf8',
      timeout: 20_000,
      cwd: scratchDir,
    }).trim();
    expect(out).toBe(manifest.version);
    expect(out).not.toBe('unknown');
  });
});
