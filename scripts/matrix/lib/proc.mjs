/**
 * Child process helpers for the installed-package matrix.
 *
 * Every case drives a real binary or a fresh Node process, so that nothing a
 * previous case warmed (a JWKS cache, a module-level singleton) can make a
 * later case look healthy.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';

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
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
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
    PATH: [...extraPath, process.env.PATH ?? ''].filter(Boolean).join(delimiter),
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
