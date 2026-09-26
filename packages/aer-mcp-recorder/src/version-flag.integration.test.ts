import { it, expect, beforeAll, describe } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distProblem } from '../../../scripts/require-dist.mjs';

// --version has to answer with the package version, like every other AER
// binary. Asserted by executing the built bin, not by importing main().

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as { version: string };
const distCli = join(pkgRoot, 'dist', 'cli.js');

beforeAll(() => {
  const problem = distProblem(pkgRoot);
  if (problem) throw new Error(problem);
});

function run(args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync(process.execPath, [distCli, ...args], { encoding: 'utf8', timeout: 20_000 });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: (err.stdout ?? '') + (err.stderr ?? ''), code: err.status ?? 1 };
  }
}

describe('aer-mcp-recorder --version', () => {
  it('prints the package version and exits 0', () => {
    const r = run(['--version']);
    expect(r.out.trim()).toBe(manifest.version);
    expect(r.code).toBe(0);
  });

  it('answers -V the same way', () => {
    const r = run(['-V']);
    expect(r.out.trim()).toBe(manifest.version);
    expect(r.code).toBe(0);
  });

  it('does not fall back to the usage description line', () => {
    const r = run(['--version']);
    expect(r.out).not.toContain('transparent MCP proxy');
  });
});
