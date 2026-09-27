/**
 * Case registry, per-case context and the report.
 *
 * A case passes when its function returns and fails when it throws. A known
 * issue is written the other way round: its function asserts the CORRECT
 * behaviour, so while the defect exists it throws and is reported as KNOWN,
 * and the day it stops throwing it is reported as XPASS so the marker gets
 * removed instead of hiding a fix (or a regression of the test itself).
 */
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { run, makeTmp, cleanEnv } from './proc.mjs';
import { startSink } from './sink.mjs';

export class AssertionError extends Error {}

const fmt = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > 400 ? `${s.slice(0, 400)}...` : s;
};

export const assert = {
  ok(cond, msg) { if (!cond) throw new AssertionError(msg); },
  equal(actual, expected, msg) {
    if (actual !== expected) throw new AssertionError(`${msg}: expected ${fmt(expected)}, got ${fmt(actual)}`);
  },
  exit(r, code, msg) {
    if (r.code !== code) {
      throw new AssertionError(`${msg}: expected exit ${code}, got ${r.code}${r.timedOut ? ' (timed out)' : ''}; stderr: ${fmt(r.stderr.trim())}; stdout: ${fmt(r.stdout.trim())}`);
    }
  },
  nonZero(r, msg) {
    if (r.code === 0 || r.code === null) throw new AssertionError(`${msg}: expected a non-zero exit, got ${r.code}${r.timedOut ? ' (timed out)' : ''}; stdout: ${fmt(r.stdout.trim())}`);
  },
  includes(hay, needle, msg) {
    if (!String(hay).includes(needle)) throw new AssertionError(`${msg}: ${fmt(needle)} not found in ${fmt(hay)}`);
  },
  excludes(hay, needle, msg) {
    if (String(hay).includes(needle)) throw new AssertionError(`${msg}: ${fmt(needle)} must not appear`);
  },
  match(hay, re, msg) {
    if (!re.test(String(hay))) throw new AssertionError(`${msg}: ${re} did not match ${fmt(hay)}`);
  },
};

/**
 * Plant these strings in prompts, arguments, results and file content. None
 * may ever reach a sink.
 */
export function canaries(tag = 'MX') {
  const id = randomUUID().replace(/-/g, '').slice(0, 12);
  return {
    prompt: `CANARY_${tag}_PROMPT_${id}`,
    args: `CANARY_${tag}_ARGS_${id}`,
    result: `CANARY_${tag}_RESULT_${id}`,
    file: `CANARY_${tag}_FILE_${id}`,
    secret: `CANARY_${tag}_SECRET_${id}`,
    path: `canary-${tag.toLowerCase()}-path-${id}`,
    query: `canary_${tag.toLowerCase()}_query_${id}`,
    all() { return [this.prompt, this.args, this.result, this.file, this.secret, this.query]; },
  };
}

/** Throw if any canary string appears in `text`. */
export function assertNoCanaries(text, c, where = 'sink') {
  const leaked = c.all().filter((s) => String(text).includes(s));
  if (leaked.length) throw new AssertionError(`bodies-off violated: ${leaked.join(', ')} reached the ${where}`);
}

export function createRegistry() {
  const suites = [];
  return {
    suites,
    /** Get or create a suite; several case files may add to one. */
    suite(name, pkg) {
      let s = suites.find((x) => x.name === name);
      if (!s) { s = { name, pkg, cases: [] }; suites.push(s); }
      if (pkg && !s.pkg) s.pkg = pkg;
      return {
        case(caseName, fn, opts = {}) { s.cases.push({ name: caseName, fn, kind: 'case', ...opts }); },
        known(caseName, issue, fn, opts = {}) { s.cases.push({ name: caseName, fn, kind: 'known', issue, ...opts }); },
        skip(caseName, reason) { s.cases.push({ name: caseName, kind: 'skip', reason }); },
      };
    },
  };
}

/**
 * Per-case context. Everything a case allocates (sinks, temp dirs) is torn
 * down when the case ends, pass or fail.
 */
export function makeContext(env, suite, caseName) {
  const cleanups = [];
  const notes = [];
  const caseRoot = makeTmp(env.tmpRoot, `${suite.name}-`);
  const ctx = {
    opts: env.opts,
    install: env.install,
    repoRoot: env.repoRoot,
    assert,
    note(msg) { notes.push(String(msg)); },
    notes,
    root: caseRoot,
    tmp(prefix = 'd-') { return makeTmp(caseRoot, prefix); },
    /** A fresh temporary HOME. */
    home() { return makeTmp(caseRoot, 'home-'); },
    /** A clean child env for `home`, with the installed bins on PATH. */
    env(home, extra = {}) { return cleanEnv(home, extra, [env.install.binDir]); },
    async sink(opts) {
      const s = await startSink(opts);
      cleanups.push(() => s.close());
      return s;
    },
    run,
    /** Run an installed bin through its node_modules/.bin symlink. */
    bin(name, args = [], o = {}) {
      return run(join(env.install.binDir, name), args, o);
    },
    /**
     * Run `source` as an ES module in a FRESH Node process whose module
     * resolution sees only the installed packages. Returns the run result;
     * `json` is the last stdout line parsed, when it parses.
     */
    async node(source, o = {}) {
      const dir = join(env.install.dir, '.matrix-scripts');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${suite.name}-${randomUUID()}.mjs`);
      writeFileSync(file, source);
      cleanups.push(() => rmSync(file, { force: true }));
      const r = await run(process.execPath, [...(o.nodeArgs ?? []), file, ...(o.args ?? [])], {
        cwd: o.cwd ?? env.install.dir,
        env: o.env ?? cleanEnv(o.home ?? makeTmp(caseRoot, 'home-'), o.extraEnv ?? {}, [env.install.binDir]),
        input: o.input,
        timeoutMs: o.timeoutMs ?? 60_000,
      });
      const last = r.stdout.trim().split('\n').pop();
      try { r.json = JSON.parse(last); } catch { r.json = undefined; }
      return r;
    },
    cleanup(fn) { cleanups.push(fn); },
    async dispose() {
      for (const fn of cleanups.reverse()) {
        try { await fn(); } catch { /* best effort */ }
      }
      if (!env.opts.keep) rmSync(caseRoot, { recursive: true, force: true });
    },
  };
  return ctx;
}

/**
 * Run the suites in registry order. A suite named in `gates` guards the rest:
 * if any of its cases fails, nothing after it runs and the returned array
 * carries `aborted` set to that suite's name.
 */
export async function runSuites(registry, env, { only, gates = [] } = {}) {
  const results = [];
  for (const suite of registry.suites) {
    if (only && !only.includes(suite.name) && !gates.includes(suite.name)) continue;
    for (const c of suite.cases) {
      const base = { suite: suite.name, pkg: suite.pkg, case: c.name };
      if (c.kind === 'skip') {
        results.push({ ...base, status: 'SKIP', detail: c.reason, ms: 0 });
        env.log(`  SKIP  ${suite.name} :: ${c.name} (${c.reason})`);
        continue;
      }
      const ctx = makeContext(env, suite, c.name);
      const started = Date.now();
      let status;
      let detail = '';
      try {
        const timeoutMs = c.timeoutMs ?? 180_000;
        let timer;
        const outcome = await Promise.race([
          Promise.resolve().then(() => c.fn(ctx)),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new AssertionError(`case timed out after ${timeoutMs} ms`)), timeoutMs); }),
        ]).finally(() => clearTimeout(timer));
        if (outcome && typeof outcome === 'object' && outcome.skip) {
          status = 'SKIP';
          detail = outcome.skip;
        } else {
          status = c.kind === 'known' ? 'XPASS' : 'PASS';
          if (c.kind === 'known') detail = `known issue no longer reproduces: ${c.issue}`;
        }
      } catch (err) {
        const msg = err instanceof AssertionError ? err.message : (err?.stack ?? String(err));
        status = c.kind === 'known' ? 'KNOWN' : 'FAIL';
        detail = c.kind === 'known' ? `${c.issue} | observed: ${msg}` : msg;
      }
      await ctx.dispose();
      const ms = Date.now() - started;
      const r = { ...base, status, detail, ms };
      if (ctx.notes.length) r.notes = ctx.notes;
      if (c.issue) r.issue = c.issue;
      results.push(r);
      const extra = status === 'PASS' ? '' : [detail, ...ctx.notes.map((n) => `note: ${n}`)].join('\n');
      env.log(`  ${status.padEnd(5)} ${suite.name} :: ${c.name} (${ms} ms)${extra ? `\n        ${extra.split('\n').join('\n        ')}` : ''}`);
    }
    if (gates.includes(suite.name) && results.some((r) => r.suite === suite.name && r.status === 'FAIL')) {
      env.log(`\nthe ${suite.name} suite failed: stopping before any other suite runs`);
      results.aborted = suite.name;
      return results;
    }
  }
  return results;
}

const STATUSES = ['PASS', 'FAIL', 'KNOWN', 'XPASS', 'SKIP'];

export function summarize(results) {
  const by = new Map();
  for (const r of results) {
    if (!by.has(r.suite)) by.set(r.suite, Object.fromEntries(STATUSES.map((s) => [s, 0])));
    by.get(r.suite)[r.status] += 1;
  }
  return by;
}

export function table(results) {
  const by = summarize(results);
  const rows = [['suite', ...STATUSES]];
  const tot = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const [name, counts] of by) {
    rows.push([name, ...STATUSES.map((s) => String(counts[s]))]);
    for (const s of STATUSES) tot[s] += counts[s];
  }
  rows.push(['TOTAL', ...STATUSES.map((s) => String(tot[s]))]);
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ');
  const out = [line(rows[0]), w.map((n) => '-'.repeat(n)).join('  ')];
  for (const r of rows.slice(1, -1)) out.push(line(r));
  out.push(w.map((n) => '-'.repeat(n)).join('  '));
  out.push(line(rows[rows.length - 1]));
  return out.join('\n');
}

export function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}
