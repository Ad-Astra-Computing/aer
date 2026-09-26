/**
 * Child process helpers for the installed-package matrix.
 *
 * Every case drives a real binary or a fresh Node process, so that nothing a
 * previous case warmed (a JWKS cache, a module-level singleton) can make a
 * later case look healthy.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter, dirname } from 'node:path';

/** The production API. No case process may ever be pointed at it. */
export const PRODUCTION_HOST = 'api.aer.run';

/**
 * A proxy nothing listens on. Every case process gets it with
 * NODE_USE_ENV_PROXY, so an outbound request to anything but the loopback
 * sinks fails to connect instead of reaching a real service. A client that
 * falls back to its default base URL (https://api.aer.run) is refused here
 * even though the case never named that host.
 */
const BLACKHOLE_PROXY = 'http://127.0.0.1:9';
const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY'];

/**
 * Whether this Node honours NODE_USE_ENV_PROXY for fetch AND node:http(s).
 * fetch gained it in 24.0 and 22.21, the http and https global agents in
 * 24.5 and 22.21 (Node's http.md, Built-in Proxy Support). 23.x never had
 * the http half. Below this the blackhole proxy silently does nothing.
 */
export function proxyGuardSupported(version = process.version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version));
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  if (major >= 25) return true;
  if (major === 24) return minor >= 5;
  if (major === 22) return minor >= 21;
  return false;
}

/** The versions proxyGuardSupported accepts, for the refusal message. */
export const PROXY_GUARD_FLOOR = 'Node 22.21, 24.5 or later (not 23)';

/** Raised when a case would hand a child process a production target. */
export class ProductionTargetError extends Error {}

/**
 * Remove every AER_* variable from this process's own environment and return
 * their names. The matrix is often started from a shell that carries real
 * credentials (an agent's tool shell does), and nothing it spawns may inherit
 * them, including a spawn that forgot to pass an explicit env.
 */
export function scrubOwnEnv() {
  const removed = Object.keys(process.env).filter((k) => k.startsWith('AER_'));
  for (const k of removed) delete process.env[k];
  return removed;
}

/**
 * Refuse, loudly, to start a child whose environment or arguments name the
 * production API or carry an AER_* variable this process was started with.
 * `allowProduction` is for the explicit --live cases only.
 */
export function assertNoProductionTarget(cmd, args, env, { allowProduction = false } = {}) {
  if (allowProduction) return;
  const hits = [];
  for (const [k, v] of Object.entries(env ?? {})) {
    if (typeof v === 'string' && v.includes(PRODUCTION_HOST)) hits.push(`env ${k}`);
  }
  for (const a of args ?? []) if (String(a).includes(PRODUCTION_HOST)) hits.push(`argument ${JSON.stringify(a)}`);
  if (hits.length) {
    throw new ProductionTargetError(`refusing to run ${cmd}: ${hits.join(', ')} names ${PRODUCTION_HOST}; cases must only ever talk to a local sink`);
  }
}

/** Drop the blackhole proxy from an env, for the few steps that need the network (npm, pip). */
export function withNetwork(env) {
  const out = { ...env };
  for (const k of PROXY_VARS) delete out[k];
  return out;
}

/** Binaries the matrix tests. A copy of any of them elsewhere must not be found. */
export const AER_BINS = ['aer', 'aer-hook', 'aer-hooks', 'aer-mcp-recorder'];

/**
 * The machine's PATH minus every directory that holds an AER binary, with
 * Node's own directory kept. A developer machine often has an older aer-hook
 * installed (a nix profile, a global npm), and a case that resolved it
 * instead of the install under test would report on the wrong code.
 */
export function strippedPath() {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const kept = dirs.filter((d) => !AER_BINS.some((b) => existsSync(join(d, b))));
  const nodeDir = dirname(process.execPath);
  if (!kept.includes(nodeDir)) kept.unshift(nodeDir);
  return kept;
}

/**
 * Run a command and collect its output. Never rejects for a non-zero exit:
 * the exit code is data the caller asserts on.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string,string>, input?: string|Buffer,
 *           timeoutMs?: number }} [opts]
 * @returns {Promise<{ code: number|null, signal: string|null, stdout: string,
 *           stderr: string, stdoutBuf: Buffer, timedOut: boolean, ms: number }>}
 */
export function run(cmd, args = [], opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const started = Date.now();
  // Never the raw parent env: AER_* is scrubbed at startup, and this drops
  // anything that slipped back in.
  const env = opts.env ?? Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AER_')));
  try {
    assertNoProductionTarget(cmd, args, env, { allowProduction: opts.allowProduction });
  } catch (err) {
    return Promise.reject(err);
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: null, signal: null, stdout: '', stderr: String(err), stdoutBuf: Buffer.alloc(0), timedOut: false, ms: 0, spawnError: err });
      return;
    }
    const out = [];
    const errc = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => errc.push(d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout: '', stderr: String(err), stdoutBuf: Buffer.alloc(0), timedOut, ms: Date.now() - started, spawnError: err });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const stdoutBuf = Buffer.concat(out);
      resolve({
        code,
        signal,
        stdout: stdoutBuf.toString('utf8'),
        stderr: Buffer.concat(errc).toString('utf8'),
        stdoutBuf,
        timedOut,
        ms: Date.now() - started,
      });
    });
    child.stdin.on('error', () => {});
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** A fresh temporary directory under the run's root. */
export function makeTmp(root, prefix = 'case-') {
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, prefix));
}

/**
 * Build a clean environment for a child. Nothing from the parent leaks in
 * except PATH and locale: no AER_* variables, no NODE_OPTIONS, no real HOME.
 * Every XDG directory points inside the temporary HOME, so a binary that
 * writes a cache or reads a config finds only what the case put there.
 */
export function cleanEnv(home, extra = {}, extraPath = []) {
  mkdirSync(join(home, '.config'), { recursive: true });
  mkdirSync(join(home, '.cache'), { recursive: true });
  mkdirSync(join(home, '.local', 'share'), { recursive: true });
  mkdirSync(join(home, '.local', 'state'), { recursive: true });
  const env = {
    PATH: [...extraPath, ...strippedPath()].filter(Boolean).join(delimiter),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: process.env.LANG ?? 'C.UTF-8',
    NO_COLOR: '1',
    // npm must not read the real user config or cache.
    npm_config_userconfig: join(home, '.npmrc'),
    npm_config_cache: join(home, '.npm'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    // Outbound traffic other than to the loopback sinks goes nowhere.
    NODE_USE_ENV_PROXY: '1',
    HTTP_PROXY: BLACKHOLE_PROXY,
    HTTPS_PROXY: BLACKHOLE_PROXY,
    http_proxy: BLACKHOLE_PROXY,
    https_proxy: BLACKHOLE_PROXY,
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null) delete env[k];
    else env[k] = String(v);
  }
  return env;
}

/** Write a file, creating parent directories. */
export function writeFile(path, content) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

/** Resolve after `ms` milliseconds. */
export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns truthy or the deadline passes. */
export async function waitFor(fn, { timeoutMs = 10_000, intervalMs = 50 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) return v;
    await delay(intervalMs);
  }
}
