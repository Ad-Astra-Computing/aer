/**
 * The Nix flake, built from this checkout: the CLI through `nix run`, every
 * binary in the `tools` output and the Python SDK package.
 *
 * The flake ref is the worktree path, which Nix reads as a git flake: only
 * tracked files are seen, the same set a `github:` consumer would get.
 * Registry mode has nothing to test here, because Nix builds from source.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../lib/proc.mjs';

const SLOW = { timeoutMs: 1_200_000 };

// Binary -> the package whose version it must print.
const TOOLS = {
  aer: 'apps/cli',
  'aer-hooks': 'packages/aer-hooks',
  'aer-hook': 'packages/aer-hooks',
  'aer-mcp-recorder': 'packages/aer-mcp-recorder',
};

/** Nix runs with the invoking user's environment so its caches are reused. */
function nixEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AER_') && k !== 'NODE_OPTIONS'));
}

async function nixMissing() {
  const r = await run('nix', ['--version'], { env: nixEnv(), timeoutMs: 20_000 });
  return r.code === 0 ? null : { skip: 'nix is not on PATH' };
}

const versionOf = (repoRoot, dir) => JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8')).version;

export default function register(registry, env) {
  const t = registry.suite('nix', 'flake.nix');
  if (env.opts.skipNix) {
    t.skip('nix flake', 'skipped by --skip-nix');
    return;
  }
  if (env.opts.source !== 'local') {
    t.skip('nix flake', 'Nix builds from source, not from npm; covered by --source local');
    return;
  }
  const flake = env.repoRoot;

  t.case('nix run .#aer -- --version prints the CLI version', async (c) => {
    const miss = await nixMissing();
    if (miss) return miss;
    const r = await run('nix', ['run', `${flake}#aer`, '--', '--version'], { env: nixEnv(), cwd: c.tmp(), timeoutMs: SLOW.timeoutMs });
    c.assert.exit(r, 0, 'nix run .#aer -- --version');
    c.assert.equal(r.stdout.trim(), versionOf(flake, 'apps/cli'), 'version');
  }, SLOW);

  t.case('nix build .#tools: every binary prints its package version', async (c) => {
    const miss = await nixMissing();
    if (miss) return miss;
    const out = join(c.tmp(), 'result');
    const b = await run('nix', ['build', `${flake}#tools`, '--out-link', out], { env: nixEnv(), timeoutMs: SLOW.timeoutMs });
    c.assert.exit(b, 0, 'nix build .#tools');
    const present = readdirSync(join(out, 'bin')).sort();
    const missing = Object.keys(TOOLS).filter((n) => !present.includes(n));
    c.assert.ok(missing.length === 0, `tools output lacks ${missing.join(', ')} (has ${present.join(', ')})`);
    for (const [bin, dir] of Object.entries(TOOLS)) {
      const r = await run(join(out, 'bin', bin), ['--version'], { env: c.env(c.home()), timeoutMs: 20_000, input: '' });
      c.assert.exit(r, 0, `${bin} --version`);
      c.assert.equal(r.stdout.trim(), versionOf(flake, dir), `${bin} --version`);
    }
    const extra = present.filter((n) => !(n in TOOLS));
    if (extra.length) c.note(`tools output also has ${extra.join(', ')}`);
  }, SLOW);

  t.case('nix build .#sdk-py: builds, runs its tests, version matches _version.py', async (c) => {
    const miss = await nixMissing();
    if (miss) return miss;
    const out = join(c.tmp(), 'result');
    const b = await run('nix', ['build', `${flake}#sdk-py`, '--out-link', out], { env: nixEnv(), timeoutMs: SLOW.timeoutMs });
    c.assert.exit(b, 0, 'nix build .#sdk-py');
    const want = readFileSync(join(flake, 'packages/sdk-py/src/aer_sdk/_version.py'), 'utf8').match(/__version__\s*=\s*"([^"]+)"/)[1];
    const site = join(out, 'lib');
    c.assert.ok(existsSync(site), 'no lib/ in the sdk-py output');
    const pyDir = readdirSync(site).find((n) => n.startsWith('python3'));
    const dist = pyDir && readdirSync(join(site, pyDir, 'site-packages')).find((n) => /^aer_sdk-.*\.dist-info$/.test(n));
    c.assert.ok(dist, 'no aer_sdk dist-info in the output');
    c.assert.equal(dist.replace(/^aer_sdk-/, '').replace(/\.dist-info$/, ''), want, 'packaged version');
  }, SLOW);
}
