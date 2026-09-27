/**
 * Package hygiene and bin basics, for every publishable package, checked on
 * the INSTALLED copy (which is exactly the tarball's contents).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const suiteName = (pkgName) => pkgName.replace('@adastracomputing/', '');

function walk(dir, base = dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (n === 'node_modules') continue;
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(p.slice(base.length + 1));
  }
  return out;
}

/** Every file target reachable from an exports map, with its condition path. */
function exportTargets(exp, path = []) {
  if (typeof exp === 'string') return [{ cond: path.join('.'), target: exp }];
  if (Array.isArray(exp)) return exp.flatMap((e, i) => exportTargets(e, [...path, String(i)]));
  if (exp && typeof exp === 'object') return Object.entries(exp).flatMap(([k, v]) => exportTargets(v, [...path, k]));
  return [];
}

export default function register(registry, env) {
  for (const name of env.publishable.keys()) {
    const t = registry.suite(suiteName(name), name);

    t.case('hygiene: README, LICENSE and CHANGELOG ship', (c) => {
      const dir = c.install.pkgDir(name);
      for (const f of ['README.md', 'LICENSE', 'package.json']) c.assert.ok(existsSync(join(dir, f)), `${f} missing from the tarball`);
      if (!existsSync(join(dir, 'CHANGELOG.md'))) c.note('no CHANGELOG.md in the tarball');
    });

    t.case('hygiene: no tests, sources maps to src or stray files', (c) => {
      const files = walk(c.install.pkgDir(name));
      const bad = files.filter((f) => /(^|\/)(__tests__|test|tests|fixtures)\/|\.(test|spec)\.[cm]?[jt]sx?$|\.test\.d\.ts$|(^|\/)src\/.*\.ts$|\.tsbuildinfo$|(^|\/)\.env/.test(f));
      c.assert.ok(bad.length === 0, `unexpected files in the tarball: ${bad.slice(0, 10).join(', ')}`);
      c.note(`${files.length} files`);
    });

    t.case('hygiene: no install scripts, no workspace ranges, engines set', (c) => {
      const m = c.install.manifest(name);
      const scripts = Object.keys(m.scripts ?? {}).filter((s) => ['preinstall', 'install', 'postinstall', 'prepare'].includes(s));
      c.assert.ok(scripts.length === 0, `install-time scripts present: ${scripts.join(', ')}`);
      for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const [dep, range] of Object.entries(m[field] ?? {})) {
          c.assert.ok(!String(range).startsWith('workspace:'), `${field}.${dep} is ${range}; pnpm pack did not rewrite it`);
        }
      }
      c.assert.ok(m.engines?.node, 'engines.node is not declared');
      c.note(`engines.node ${m.engines.node}; tested on ${process.version}`);
      const ext = Object.keys(m.dependencies ?? {}).filter((d) => !d.startsWith('@adastracomputing/'));
      if (ext.length) c.note(`third-party runtime dependencies: ${ext.join(', ')}`);
      c.assert.equal(m.type, 'module', 'package type');
    });

    t.case('hygiene: exports, types and bin targets resolve', (c) => {
      const dir = c.install.pkgDir(name);
      const m = c.install.manifest(name);
      const missing = [];
      for (const { cond, target } of exportTargets(m.exports ?? {})) {
        if (!existsSync(join(dir, target))) missing.push(`exports ${cond} -> ${target}`);
      }
      for (const f of ['main', 'module', 'types', 'typings']) {
        if (m[f] && !existsSync(join(dir, m[f]))) missing.push(`${f} -> ${m[f]}`);
      }
      const bins = typeof m.bin === 'string' ? { [name]: m.bin } : (m.bin ?? {});
      for (const [b, target] of Object.entries(bins)) {
        const p = join(dir, target);
        if (!existsSync(p)) { missing.push(`bin ${b} -> ${target}`); continue; }
        const head = readFileSync(p, 'utf8').slice(0, 40);
        if (!head.startsWith('#!')) missing.push(`bin ${b} has no shebang`);
        if (!existsSync(join(c.install.binDir, b))) missing.push(`bin ${b} was not linked into node_modules/.bin`);
      }
      c.assert.ok(missing.length === 0, missing.join('; '));
      // A library must ship types for every import entry it exposes.
      const isLibrary = m.exports && Object.keys(m.exports).length > 0;
      if (isLibrary) {
        const entries = typeof m.exports === 'string' ? { '.': m.exports } : m.exports;
        const untyped = Object.entries(entries).filter(([, v]) => !exportTargets(v).some((x) => /\.d\.[cm]?ts$/.test(x.target)));
        c.assert.ok(untyped.length === 0, `export entries without types: ${untyped.map(([k]) => k).join(', ')}`);
      }
    });

    t.case('hygiene: every export entry imports in a fresh Node', async (c) => {
      const m = c.install.manifest(name);
      if (!m.exports) return { skip: 'no exports map (CLI only)' };
      const subpaths = Object.keys(m.exports).filter((k) => k.startsWith('.'));
      // ./register starts a collector on import; it is exercised by the
      // aer-auto-node suite under NODE_OPTIONS instead.
      const specs = subpaths.filter((s) => s !== './register').map((s) => (s === '.' ? name : `${name}/${s.slice(2)}`));
      const r = await c.node(`
        const out = {};
        for (const s of ${JSON.stringify(specs)}) {
          try { const mod = await import(s); out[s] = Object.keys(mod).length; }
          catch (e) { out[s] = 'ERR ' + (e && e.message); }
        }
        console.log(JSON.stringify(out));
      `);
      c.assert.exit(r, 0, 'import script');
      const errs = Object.entries(r.json ?? {}).filter(([, v]) => typeof v === 'string');
      // A framework adapter may need its peer installed; that is a note, a
      // missing module of our own is a failure.
      const hard = errs.filter(([, v]) => !/Cannot find (package|module) '(hono|express)/.test(v));
      for (const [k, v] of errs) if (!hard.some(([h]) => h === k)) c.note(`${k}: ${v} (optional peer not installed)`);
      c.assert.ok(hard.length === 0, `imports failed: ${JSON.stringify(Object.fromEntries(hard))}`);
      const empty = Object.entries(r.json ?? {}).filter(([, v]) => v === 0);
      c.assert.ok(empty.length === 0, `export entries with no exports: ${empty.map(([k]) => k).join(', ')}`);
    });

    const m0 = JSON.parse(readFileSync(join(env.publishable.get(name), 'package.json'), 'utf8'));
    const bins = typeof m0.bin === 'string' ? { [name]: m0.bin } : (m0.bin ?? {});
    for (const bin of Object.keys(bins)) {
      t.case(`bin ${bin}: --version and -V print the real version`, async (c) => {
        const home = c.home();
        const want = c.install.version(name);
        for (const flag of ['--version', '-V']) {
          const r = await c.bin(bin, [flag], { env: c.env(home), timeoutMs: 20_000 });
          c.assert.exit(r, 0, `${bin} ${flag}`);
          const printed = r.stdout.trim();
          c.assert.ok(!/^(0\.0\.0|unknown|undefined)$/.test(printed), `${bin} ${flag} printed ${printed}`);
          c.assert.ok(printed.includes(want), `${bin} ${flag} printed "${printed.slice(0, 200)}", expected it to contain ${want}`);
          c.assert.ok(printed.split('\n').length <= 2, `${bin} ${flag} printed more than a version: ${printed.slice(0, 200)}`);
        }
      });
      if (bin === 'aer-hook') {
        // The per-event hook binary has a stricter contract than a CLI: a
        // harness runs it on every tool call, so it must exit 0 with an empty
        // stdout whatever it is given, a flag it does not know included. A
        // non-zero exit or stray stdout would fail or corrupt the harness.
        for (const args of [['--help'], ['--definitely-not-a-flag']]) {
          t.case(`bin aer-hook: ${args[0]} exits 0 with empty stdout (hook contract)`, async (c) => {
            const r = await c.bin(bin, args, { env: c.env(c.home()), timeoutMs: 20_000, input: '' });
            c.assert.exit(r, 0, `aer-hook ${args[0]}`);
            c.assert.equal(r.stdout, '', `aer-hook ${args[0]} stdout`);
            if (!r.stderr.trim()) c.note(`aer-hook ${args[0]} prints nothing at all, not even usage on stderr`);
          });
        }
        continue;
      }
      t.case(`bin ${bin}: --help exits 0 and prints usage`, async (c) => {
        const home = c.home();
        const r = await c.bin(bin, ['--help'], { env: c.env(home), timeoutMs: 20_000 });
        c.assert.exit(r, 0, `${bin} --help`);
        c.assert.ok(`${r.stdout}${r.stderr}`.trim().length > 40, `${bin} --help printed almost nothing`);
        c.assert.excludes(`${r.stdout}${r.stderr}`, 'Error:', `${bin} --help`);
      });
      t.case(`bin ${bin}: an unknown flag exits non-zero`, async (c) => {
        const home = c.home();
        const r = await c.bin(bin, ['--definitely-not-a-flag'], { env: c.env(home), timeoutMs: 20_000, input: '' });
        c.assert.ok(!r.timedOut, `${bin} --definitely-not-a-flag hung`);
        c.assert.nonZero(r, `${bin} --definitely-not-a-flag`);
      });
    }
  }
}
