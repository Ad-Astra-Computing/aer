import { it, expect, beforeAll, describe } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every binary has to be able to say what version it is. It is the first thing
// asked when a recording looks wrong, and a collector that cannot answer it
// leaves a support conversation with nothing to go on. Asserted by EXECUTING
// each bin: an import-level test cannot see argv handling at all, which is how
// this went out in a release.

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const manifest = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as {
  version: string;
  bin: Record<string, string>;
};

// Tests never build. A sibling file spawning this dist would load it half
// written, so dist comes from one build that finishes before any test runs.
beforeAll(() => {
  if (!existsSync(join(pkgRoot, 'dist', 'cli.js'))) throw new Error('dist is missing: run pnpm -r build first');
});

function run(entry: string, args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [join(pkgRoot, entry), ...args], {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: (err.stdout ?? '') + (err.stderr ?? ''), code: err.status ?? 1 };
  }
}

describe.each(Object.entries(manifest.bin))('%s --version', (name, entry) => {
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

  // aer-hook is the per-event hook the harness itself runs. It is fail-open by
  // design and must never exit non-zero, or a bad AER install breaks someone's
  // tool call. Only the operator CLI gets to reject a flag.
  const failsOpen = name === 'aer-hook';

  it(failsOpen
    ? 'stays fail-open on a flag it does not know'
    : 'still rejects a flag it does not know, so --version is not a catch-all', () => {
    const code = run(entry, ['--definitely-not-a-flag']).code;
    if (failsOpen) expect(code).toBe(0);
    else expect(code).not.toBe(0);
  });
});
