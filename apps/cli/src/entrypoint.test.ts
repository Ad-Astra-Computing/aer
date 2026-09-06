/**
 * The CLI must run when invoked the way it is actually installed.
 *
 * 0.1.1 shipped an entry-point guard comparing `import.meta.url` against an
 * unresolved `process.argv[1]`. npm links `node_modules/.bin/aer` to
 * `dist/main.js`; Node resolves that symlink for the former and not the latter,
 * so the guard was false for every installed copy and the CLI exited 0 having
 * done nothing. A `--help` smoke passed it, because the failure is silence.
 *
 * These tests run the built artifact, and then the packed tarball installed
 * into a clean directory, which is the only thing that proves what ships.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const pkgRoot = resolve(import.meta.dirname, '..');
const built = join(pkgRoot, 'dist', 'main.js');

interface Run {
  code: number | string;
  out: string;
}

async function run(bin: string, args: string[], cwd = pkgRoot): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [bin, ...args], {
      cwd,
      env: { ...process.env, AER_BASE_URL: '' },
    });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    // `code` is a number for a real exit and a string such as 'ENOENT' when the
    // process could not start; keep both rather than flattening to 1, so a
    // failure message says which happened.
    const e = err as { code?: number | string; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

const SUBCOMMANDS = [
  'init', 'doctor', 'smoke', 'ingest', 'import',
  'verify', 'commitments', 'webhooks', 'agents', 'sessions', 'findings', 'audit',
];

describe('CLI entry point', () => {
  let linked: string;

  beforeAll(() => {
    // Always rebuild. Testing whatever dist happened to be lying around is how
    // a stale bundle passes a regression test for the bug it still contains.
    execFileSync('node', ['bundle.mjs'], { cwd: pkgRoot, stdio: 'ignore' });
    const dir = mkdtempSync(join(tmpdir(), 'aer-bin-'));
    mkdirSync(join(dir, '.bin'), { recursive: true });
    linked = join(dir, '.bin', 'aer');
    symlinkSync(built, linked);
  });

  it('prints usage when run directly', async () => {
    expect((await run(built, [])).out).toContain('aer verify');
  });

  it('prints the same usage through a bin symlink', async () => {
    expect((await run(linked, [])).out).toContain('aer verify');
  });

  it('reports an unknown command instead of exiting silently', async () => {
    const { code, out } = await run(linked, ['definitely-not-a-command']);
    expect(out).not.toBe('');
    expect(code).not.toBe(0);
  });

  it.each(SUBCOMMANDS)('recognises %s through a bin symlink', async (cmd) => {
    const { out } = await run(linked, [cmd]);
    expect(out, `${cmd} produced no output at all`).not.toBe('');
  });
});

// Packing is slower than the rest of the file, but it is the only test here
// that runs the bytes a user receives: it catches the symlink no-op, a tarball
// missing its build, and a files-whitelist mistake, all at once.
describe('the packed tarball', () => {
  let installed: string;

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'aer-pack-'));
    // pnpm, not npm: npm leaves `workspace:*` in the dependencies of a
    // workspace package and the resulting tarball cannot be installed.
    execFileSync('pnpm', ['pack', '--pack-destination', dir], { cwd: pkgRoot, stdio: 'ignore' });
    const tarball = readdirSync(dir).find((f) => f.endsWith('.tgz'));
    if (!tarball) throw new Error('pnpm pack produced no tarball');

    const project = join(dir, 'project');
    mkdirSync(project, { recursive: true });
    execFileSync('npm', ['init', '-y'], { cwd: project, stdio: 'ignore' });
    execFileSync('npm', ['install', join(dir, tarball)], { cwd: project, stdio: 'ignore' });
    installed = join(project, 'node_modules', '.bin', 'aer');
  }, 180_000);

  it('exposes a bin that runs', async () => {
    const { out } = await run(installed, ['--help'], tmpdir());
    expect(out).toContain('aer verify');
  });

  it('recognises every subcommand', async () => {
    for (const cmd of SUBCOMMANDS) {
      const { out } = await run(installed, [cmd], tmpdir());
      expect(out, `${cmd} produced no output from the installed package`).not.toBe('');
    }
  }, 120_000);

  it('fails loudly on an unknown command', async () => {
    const { code, out } = await run(installed, ['nope'], tmpdir());
    expect(out).not.toBe('');
    expect(code).not.toBe(0);
  });
});
