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
import { mkdtempSync, mkdirSync, symlinkSync, readdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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

// Same as run(), but with explicit environment values, for the cases where
// what is being tested is which variable the CLI reads, or that a command
// routes past usage into the network.
async function runWithEnv(bin: string, args: string[], extra: Record<string, string>): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [bin, ...args], {
      cwd: pkgRoot,
      env: { ...process.env, ...extra },
    });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string };
    return { code: e.code ?? 'unknown', out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

describe('CLI entry point', () => {
  let linked: string;

  beforeAll(() => {
    // Tests never build: a sibling file spawning this bundle would load it
    // half written. `pnpm test` and CI build once, just before the tests.
    if (!existsSync(built)) throw new Error('dist is missing: run pnpm -r build first');
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

  // Nothing issues an environment id, so a placeholder left the reader with a
  // value they had no way to look up.
  it('generates an environment id rather than a placeholder', async () => {
    const project = mkdtempSync(join(tmpdir(), 'aer-init-'));
    writeFileSync(join(project, 'package.json'), '{"name":"p","version":"1.0.0","scripts":{"start":"node i.js"}}');
    writeFileSync(join(project, 'i.js'), '');
    await run(linked, ['init', '--yes'], project);
    const config = JSON.parse(readFileSync(join(project, 'aer.config.json'), 'utf8')) as Record<string, string>;
    expect(config['env_id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  // The collector documents AER_API_KEY and these commands used to read only
  // AER_TENANT_API_KEY, so the documented name printed usage instead.
  it('accepts AER_API_KEY for the tenant commands', async () => {
    const { out } = await runWithEnv(linked, ['sessions', 'list'], {
      AER_BASE_URL: 'http://127.0.0.1:9',
      AER_API_KEY: 'aer_probe',
    });
    expect(out).not.toContain('Usage:');
  });

  // Multi-word commands were never exercised here, only their first word, so
  // a build that dropped the second word would have passed. A user reported
  // exactly that. These run the real bin with the second word attached.
  it('names the missing subcommand instead of only printing usage', async () => {
    const { code, out } = await run(linked, ['sessions']);
    expect(code).toBe(64);
    expect(out).toContain('needs a subcommand');
  });

  it.each([['sessions', 'list'], ['agents', 'list'], ['aers', 'list']])(
    'routes %s %s past usage when configured',
    async (cmd, sub) => {
      // A base URL nothing listens on: the command must try the network and
      // fail there, not fall back to usage text.
      const { out } = await runWithEnv(linked, [cmd, sub], { AER_BASE_URL: 'http://127.0.0.1:9', AER_TENANT_API_KEY: 'aer_probe' });
      expect(out).not.toContain('Usage:');
      expect(out).not.toContain('needs a subcommand');
    },
  );
});

// Packing is slower than the rest of the file, but it is the only test here
// that runs the bytes a user receives: it catches the symlink no-op, a tarball
// missing its build, and a files-whitelist mistake, all at once.
describe('the packed tarball', () => {
  let installed: string;

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'aer-pack-'));
    // pnpm, not npm: npm leaves `workspace:*` in the dependencies of a
    // workspace package and the resulting tarball cannot be installed. No
    // scripts: prepack would delete dist while sibling files are running it.
    // This also skips prepare and postpack, so if either ever changes the
    // tarball, this test stops modelling what publish ships.
    execFileSync('pnpm', ['--config.ignore-scripts=true', 'pack', '--pack-destination', dir], {
      cwd: pkgRoot, stdio: 'ignore',
    });
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
