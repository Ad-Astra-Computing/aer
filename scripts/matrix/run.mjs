#!/usr/bin/env node
/**
 * Installed-package matrix: exercise every AER client package the way a
 * customer gets it, from a tarball or from the npm registry, installed into a
 * throwaway directory. Nothing here imports workspace source.
 *
 *   node scripts/matrix/run.mjs                               # local tarballs
 *   node scripts/matrix/run.mjs --source registry --tag next
 *   node scripts/matrix/run.mjs --source registry --tag next --upgrade-from latest
 *   node scripts/matrix/run.mjs --only aer-verify,aer-mcp-guard --json
 *
 * Every case talks to a local capture sink. Unless --live is given, api.aer.run
 * is never contacted:
 * the runner drops its own AER_* variables before anything else, every child
 * env is refused if it names the production API, and every case process
 * routes non-loopback traffic to a proxy nothing listens on.
 * Exit status is non-zero when any case fails.
 */
import { readdirSync, mkdirSync, rmSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRegistry, runSuites, table } from './lib/harness.mjs';
import { scrubOwnEnv, proxyGuardSupported, PROXY_GUARD_FLOOR } from './lib/proc.mjs';
import { packLocal, resolveRegistry, installInto, verifyInstalled, makeInstall, npmEnvFor, publishable } from './lib/install.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(here));

const HELP = `usage: node scripts/matrix/run.mjs [options]

  --source local|registry   where the packages come from (default local)
  --tag <dist-tag>          registry dist-tag to test (default next)
  --version <pkg>@<ver>     pin one package, overriding --tag (repeatable)
  --upgrade-from <tag>      install <tag> first, seed its config, then upgrade
                            to the candidate and verify the upgrade path
  --only <suite>[,<suite>]  run only these suites (repeatable)
  --skip-nix                report the Nix suite as SKIP instead of running it
  --skip-python             report the Python SDK suite as SKIP
  --skip-build              local mode: pack the existing dist, do not rebuild
  --live                    also run the live suite: verify the public demo
                            record on api.aer.run with the installed CLI and
                            its pinned production trust root (read-only, no
                            credentials; off by default)
  --install-dir <dir>       reuse an install prepared by --prepare-only
  --prepare-only            pack and install, print the install dir, exit
  --retry-minutes <n>       how long to retry a registry install on CDN lag (5)
  --json                    print the JSON report on stdout (logs go to stderr)
  --report <file>           also write the JSON report to <file>
  --keep                    keep temporary directories
  --list                    list the suites and exit
  -h, --help                this text`;

function parseArgs(argv) {
  const o = { source: 'local', tag: 'next', versions: {}, only: [], json: false, keep: false, skipNix: false, skipPython: false, skipBuild: false, retryMinutes: 5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--source': o.source = val(); break;
      case '--tag': o.tag = val(); break;
      case '--version': {
        const v = val();
        const at = v.lastIndexOf('@');
        if (at <= 0) throw new Error(`--version expects <pkg>@<version>, got ${v}`);
        o.versions[v.slice(0, at)] = v.slice(at + 1);
        break;
      }
      case '--upgrade-from': o.upgradeFrom = val(); break;
      case '--only': o.only.push(...val().split(',').filter(Boolean)); break;
      case '--skip-nix': o.skipNix = true; break;
      case '--skip-python': o.skipPython = true; break;
      case '--skip-build': o.skipBuild = true; break;
      case '--live': o.live = true; break;
      case '--install-dir': o.installDir = val(); break;
      case '--prepare-only': o.prepareOnly = true; break;
      case '--retry-minutes': o.retryMinutes = Number(val()); break;
      case '--json': o.json = true; break;
      case '--report': o.report = val(); break;
      case '--keep': o.keep = true; break;
      case '--list': o.list = true; break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`unknown option ${a}`);
    }
  }
  if (!['local', 'registry'].includes(o.source)) throw new Error(`--source must be local or registry, got ${o.source}`);
  return o;
}

async function loadRegistry(env) {
  const registry = createRegistry();
  const dir = join(here, 'cases');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.mjs')).sort()) {
    const mod = await import(pathToFileURL(join(dir, f)).href);
    await mod.default(registry, env);
  }
  return registry;
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (err) {
    process.stderr.write(`${err.message}\n\n${HELP}\n`);
    process.exit(2);
  }
  if (opts.help) { process.stdout.write(`${HELP}\n`); return; }
  const log = (m) => process.stderr.write(`${m}\n`);
  // The network guard that keeps cases off production depends on Node's
  // own proxy support. Refuse rather than run a matrix that only looks safe.
  if (!opts.list && !proxyGuardSupported(process.version)) {
    process.stderr.write(`the matrix needs ${PROXY_GUARD_FLOOR}: this is ${process.version}, whose NODE_USE_ENV_PROXY does not cover both fetch and node:http(s), so a case could reach a real service. Use a newer Node.\n`);
    process.exit(2);
  }
  const scrubbed = scrubOwnEnv();
  if (scrubbed.length) log(`dropped ${scrubbed.join(', ')} from the matrix environment; no case may inherit them`);
  const out = opts.json ? log : (m) => process.stdout.write(`${m}\n`);

  const workRoot = mkdtempSync(join(process.env.MATRIX_TMPDIR ?? tmpdir(), 'aer-matrix-'));
  const env = {
    opts,
    repoRoot,
    tmpRoot: join(workRoot, 'cases'),
    workRoot,
    log,
    npmEnv: npmEnvFor(workRoot),
    publishable: publishable(repoRoot),
  };

  if (opts.list) {
    env.install = makeInstall(join(workRoot, 'install'), {});
    const reg = await loadRegistry(env);
    for (const s of reg.suites) out(`${s.name.padEnd(20)} ${s.cases.length} cases`);
    rmSync(workRoot, { recursive: true, force: true });
    return;
  }

  const report = {
    schema: 'aer-matrix-report.v1',
    source: opts.source,
    tag: opts.source === 'registry' ? opts.tag : undefined,
    upgradeFrom: opts.upgradeFrom,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    startedAt: new Date().toISOString(),
    versions: {},
    results: [],
  };

  let exitCode = 0;
  try {
    // The candidate: what this run is testing.
    let specs;
    let installDir;
    if (opts.installDir) {
      installDir = opts.installDir;
      const lock = join(installDir, 'matrix-specs.json');
      if (!existsSync(lock)) throw new Error(`${installDir} was not prepared by --prepare-only (no matrix-specs.json)`);
      specs = JSON.parse((await import('node:fs')).readFileSync(lock, 'utf8'));
      log(`reusing the install at ${installDir}`);
    } else {
      specs = opts.source === 'local'
        ? await packLocal({ repoRoot, workRoot, log, skipBuild: opts.skipBuild })
        : await resolveRegistry({ repoRoot, tag: opts.tag, overrides: opts.versions, log, npmEnv: env.npmEnv });
      if (opts.source === 'local' && Object.keys(opts.versions).length) {
        throw new Error('--version applies to --source registry only');
      }
    }
    for (const [name, s] of Object.entries(specs)) report.versions[name] = s.version;
    env.specs = specs;

    if (opts.upgradeFrom) {
      // The upgrade suite installs the old versions, seeds their state and
      // upgrades in place, one throwaway project per case.
      env.fromSpecs = await resolveRegistry({ repoRoot, tag: opts.upgradeFrom, overrides: {}, log, npmEnv: env.npmEnv });
      report.upgradeFromVersions = Object.fromEntries(Object.entries(env.fromSpecs).map(([k, v]) => [k, v.version]));
      env.installInto = (dir, s) => installInto(dir, s, { log, npmEnv: env.npmEnv, retryMinutes: opts.retryMinutes, registry: true });
      env.verifyInstalled = verifyInstalled;
      env.install = makeInstall(join(workRoot, 'install'), specs);
      const reg = await loadRegistry(env);
      const only = opts.only.length ? opts.only : ['upgrade'];
      log(`\nupgrade path: ${opts.upgradeFrom} -> ${opts.source === 'local' ? 'local tarballs' : opts.tag}`);
      report.results = await runSuites(reg, env, { only, gates: ['harness'] });
    } else {
      if (!opts.installDir) {
        installDir = join(workRoot, 'install');
        log(`installing ${Object.keys(specs).length} packages into ${installDir}`);
        await installInto(installDir, specs, { log, npmEnv: env.npmEnv, retryMinutes: opts.retryMinutes, registry: opts.source === 'registry' });
        writeFileSync(join(installDir, 'matrix-specs.json'), JSON.stringify(specs, null, 2));
      }
      const problems = verifyInstalled(installDir, specs, { local: opts.source === 'local' });
      if (problems.length) throw new Error(`the install is not the candidate:\n  ${problems.join('\n  ')}`);
      if (opts.prepareOnly) {
        out(installDir);
        return;
      }
      env.install = makeInstall(installDir, specs);
      const reg = await loadRegistry(env);
      const only = opts.only.length ? opts.only : reg.suites.map((s) => s.name).filter((n) => n !== 'upgrade');
      const unknown = only.filter((n) => !reg.suites.some((s) => s.name === n));
      if (unknown.length) throw new Error(`unknown suite(s): ${unknown.join(', ')}; see --list`);
      log(`\nrunning ${only.length} suites against ${opts.source === 'local' ? 'local tarballs' : `${opts.tag} on npmjs`} on Node ${process.version}`);
      report.results = await runSuites(reg, env, { only, gates: ['harness'] });
    }
  } catch (err) {
    log(`\nmatrix setup failed: ${err?.stack ?? err}`);
    report.setupError = String(err?.message ?? err);
    exitCode = 2;
  }

  if (report.results.aborted) {
    report.aborted = `the ${report.results.aborted} suite failed, so no other suite ran`;
    exitCode = 2;
  }
  report.finishedAt = new Date().toISOString();
  const failed = report.results.filter((r) => r.status === 'FAIL');
  const known = report.results.filter((r) => r.status === 'KNOWN');
  const xpass = report.results.filter((r) => r.status === 'XPASS');
  report.summary = {
    pass: report.results.filter((r) => r.status === 'PASS').length,
    fail: failed.length,
    known: known.length,
    xpass: xpass.length,
    skip: report.results.filter((r) => r.status === 'SKIP').length,
  };

  if (report.results.length) {
    out(`\n${table(report.results)}`);
    const section = (title, rows) => {
      if (!rows.length) return;
      out(`\n${title}`);
      for (const r of rows) out(`  ${r.suite} :: ${r.case}\n    ${String(r.detail).split('\n').slice(0, 6).join('\n    ')}`);
    };
    section('FAILED', failed);
    section('KNOWN ISSUES (expected failures, reported, not hidden)', known);
    section('XPASS (a known issue no longer reproduces: remove its marker)', xpass);
    const skips = report.results.filter((r) => r.status === 'SKIP');
    section('SKIPPED', skips);
  }
  if (report.aborted) out(`\nABORTED: ${report.aborted}`);
  out(`\nNode ${process.version} on ${report.platform}; source ${opts.source}${opts.source === 'registry' ? ` (${opts.tag})` : ''}${opts.upgradeFrom ? `; upgrade from ${opts.upgradeFrom}` : ''}`);

  if (opts.report) writeFileSync(opts.report, JSON.stringify(report, null, 2));
  if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!opts.keep && !opts.prepareOnly) rmSync(workRoot, { recursive: true, force: true });
  else log(`kept ${workRoot}`);
  if (exitCode === 0 && failed.length) exitCode = 1;
  process.exit(exitCode);
}

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(2);
});
