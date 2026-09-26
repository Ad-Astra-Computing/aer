/**
 * Getting the packages the way a customer gets them.
 *
 * Local mode builds the workspace and packs each publishable package with
 * `pnpm pack`. `npm pack` would leave the `workspace:*` ranges in place and
 * the tarball would not install. Registry mode resolves a dist-tag to exact
 * versions on npmjs. Either way the packages are installed with npm into a
 * throwaway directory, never linked from workspace source.
 */
import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { run, cleanEnv, delay } from './proc.mjs';

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

/** Publishable packages: name -> directory, read from the workspace. */
export function publishable(repoRoot) {
  const out = new Map();
  for (const top of ['apps', 'packages']) {
    const base = join(repoRoot, top);
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base)) {
      const f = join(base, d, 'package.json');
      if (!existsSync(f)) continue;
      const pkg = JSON.parse(readFileSync(f, 'utf8'));
      if (pkg.private || !pkg.name?.startsWith('@adastracomputing/')) continue;
      out.set(pkg.name, join(base, d));
    }
  }
  return out;
}

async function must(r, what) {
  if (r.code !== 0) {
    throw new Error(`${what} failed (exit ${r.code}${r.timedOut ? ', timed out' : ''}):\n${r.stderr.slice(-4000)}\n${r.stdout.slice(-2000)}`);
  }
  return r;
}

/** Build the workspace and pack every publishable package. */
export async function packLocal({ repoRoot, workRoot, log, skipBuild }) {
  const pkgs = publishable(repoRoot);
  const dest = join(workRoot, 'tarballs');
  mkdirSync(dest, { recursive: true });
  if (!skipBuild) {
    log('building the workspace (pnpm -r build)');
    await must(await run(PNPM, ['-r', 'build'], { cwd: repoRoot, timeoutMs: 600_000 }), 'pnpm -r build');
  }
  const specs = {};
  for (const [name, dir] of pkgs) {
    const r = await must(await run(PNPM, ['pack', '--pack-destination', dest], { cwd: dir, timeoutMs: 120_000 }), `pnpm pack ${name}`);
    const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
    const tgz = r.stdout.trim().split('\n').map((l) => l.trim()).filter((l) => l.endsWith('.tgz')).pop();
    const path = tgz?.startsWith('/') ? tgz : join(dest, basename(tgz ?? ''));
    if (!tgz || !existsSync(path)) throw new Error(`pnpm pack ${name}: no tarball found in output:\n${r.stdout}`);
    specs[name] = { spec: path, version, tarball: path, sourceDir: dir };
    log(`packed ${name}@${version}`);
  }
  return specs;
}

/**
 * Resolve every publishable package at a dist-tag to an exact version.
 * `overrides` maps a package name to a version and wins over the tag.
 */
export async function resolveRegistry({ repoRoot, tag, overrides = {}, log, npmEnv }) {
  const specs = {};
  for (const name of publishable(repoRoot).keys()) {
    let version = overrides[name];
    if (!version) {
      const r = await run(NPM, ['view', `${name}@${tag}`, 'version', '--json'], { env: npmEnv, timeoutMs: 60_000 });
      if (r.code !== 0) throw new Error(`npm view ${name}@${tag} failed: ${r.stderr.trim()}`);
      const v = JSON.parse(r.stdout || 'null');
      version = Array.isArray(v) ? v[v.length - 1] : v;
      if (!version) throw new Error(`${name} has no ${tag} dist-tag`);
    }
    specs[name] = { spec: `${name}@${version}`, version };
    log(`resolved ${name}@${tag} -> ${version}`);
  }
  return specs;
}

const isCdnLag = (text) => /ETARGET|notarget|No matching version|E404|404 Not Found/i.test(text);

/**
 * npm-install `specs` into `dir`. A registry install that fails with a
 * missing-version error is retried for up to `retryMinutes`: right after a
 * publish the npm CDN routinely serves a packument without the new version
 * for a few minutes, and that is lag, not a failed release.
 */
export async function installInto(dir, specs, { log, npmEnv, retryMinutes = 5, registry = false }) {
  mkdirSync(dir, { recursive: true });
  const pj = join(dir, 'package.json');
  if (!existsSync(pj)) {
    writeFileSync(pj, JSON.stringify({ name: 'aer-matrix-install', version: '0.0.0', private: true, type: 'module' }, null, 2));
  }
  const list = Object.values(specs).map((s) => s.spec);
  const until = Date.now() + retryMinutes * 60_000;
  for (let attempt = 1; ; attempt++) {
    const r = await run(NPM, ['install', '--no-audit', '--no-fund', '--save-exact', ...list], { cwd: dir, env: npmEnv, timeoutMs: 600_000 });
    if (r.code === 0) return r;
    const text = `${r.stderr}\n${r.stdout}`;
    if (registry && isCdnLag(text) && Date.now() < until) {
      log(`npm install attempt ${attempt} saw a missing version (CDN lag); retrying in 20 s`);
      await delay(20_000);
      continue;
    }
    throw new Error(`npm install failed (exit ${r.code}):\n${text.slice(-4000)}`);
  }
}

/**
 * Check that what npm installed is what we meant to test. In local mode every
 * AER package, nested ones included, must come from a tarball: a sibling
 * dependency silently resolved from the registry would test published code
 * and report it as the candidate.
 */
export function verifyInstalled(dir, specs, { local }) {
  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
  const problems = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    const m = path.match(/node_modules\/(@adastracomputing\/[^/]+)$/);
    if (!m) continue;
    const name = m[1];
    const want = specs[name];
    if (!want) continue;
    if (local && !String(entry.resolved ?? '').startsWith('file:')) {
      problems.push(`${path} resolved from ${entry.resolved ?? 'unknown'}, not the packed tarball`);
    }
    if (entry.version !== want.version) problems.push(`${path} is ${entry.version}, expected ${want.version}`);
  }
  for (const [name, want] of Object.entries(specs)) {
    const f = join(dir, 'node_modules', name, 'package.json');
    if (!existsSync(f)) { problems.push(`${name} is not installed`); continue; }
    const got = JSON.parse(readFileSync(f, 'utf8')).version;
    if (got !== want.version) problems.push(`${name} installed ${got}, expected ${want.version}`);
  }
  return problems;
}

export function makeInstall(dir, specs) {
  return {
    dir,
    specs,
    binDir: join(dir, 'node_modules', '.bin'),
    pkgDir: (name) => join(dir, 'node_modules', name),
    manifest: (name) => JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8')),
    /** The version this run intends to test for `name`. */
    version: (name) => specs[name]?.version,
    spec: (name) => specs[name]?.spec,
  };
}

export function npmEnvFor(workRoot) {
  const home = join(workRoot, 'npm-home');
  mkdirSync(home, { recursive: true });
  // One cache per run, shared by every install in it; never the user's.
  return cleanEnv(home, { npm_config_cache: join(workRoot, 'npm-cache') });
}
