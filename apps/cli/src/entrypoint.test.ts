/**
 * The built CLI must actually run when invoked the way npm installs it.
 *
 * npm links `node_modules/.bin/aer` to `dist/main.js`. Node resolves that
 * symlink before setting `import.meta.url`, but leaves `process.argv[1]` as the
 * symlink path, so an entry-point guard comparing the two verbatim is false for
 * every real installation. The CLI then loads, runs nothing and exits 0, which
 * looks like success to a script and prints nothing to a person.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const here = resolve(import.meta.dirname, '..');
const built = join(here, 'dist', 'main.js');

/** Run the CLI and return its exit code plus combined output. */
async function run(bin: string, args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [bin, ...args], {
      env: { ...process.env, AER_BASE_URL: '' },
    });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

describe('CLI entry point', () => {
  let linked: string;

  beforeAll(() => {
    if (!existsSync(built)) execFileSync('node', ['bundle.mjs'], { cwd: here, stdio: 'ignore' });
    // Reproduce npm's layout: a bin symlink with no extension, pointing at the
    // built entry inside the package.
    const dir = mkdtempSync(join(tmpdir(), 'aer-bin-'));
    mkdirSync(join(dir, '.bin'), { recursive: true });
    linked = join(dir, '.bin', 'aer');
    symlinkSync(built, linked);
  });

  it('prints usage when run directly', async () => {
    const { out } = await run(built, []);
    expect(out).toContain('aer verify');
  });

  it('prints the same usage through a bin symlink', async () => {
    const { out } = await run(linked, []);
    expect(out).toContain('aer verify');
  });

  it('reports an unknown command through a bin symlink instead of exiting silently', async () => {
    const { code, out } = await run(linked, ['definitely-not-a-command']);
    expect(out).not.toBe('');
    expect(code).not.toBe(0);
  });

  // Every documented subcommand must at least be recognised through the
  // symlink. A silent exit 0 here is the exact failure this file exists for.
  it.each(['init', 'doctor', 'smoke', 'ingest', 'import', 'verify', 'commitments', 'webhooks', 'agents', 'sessions', 'findings', 'audit'])(
    'recognises %s through a bin symlink',
    async (cmd) => {
      const { out } = await run(linked, [cmd]);
      expect(out, `${cmd} produced no output at all`).not.toBe('');
    },
  );
});
