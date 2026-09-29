/**
 * Drive an interactive terminal program through a pseudo-terminal, using only
 * what the machine already has: util-linux script(1) allocates the pty and
 * relays our pipe to it, so no native module is needed.
 *
 * The screen is read as a stream, not rendered: escape sequences are dropped
 * and, because a TUI moves the cursor instead of printing spaces, every
 * whitespace character is dropped too before matching. Patterns are therefore
 * written without spaces ("Trustallandcontinue").
 */
import { spawn, spawnSync } from 'node:child_process';
import { assertNoProductionTarget, delay } from './proc.mjs';

let scriptOk;
/** Why a pty cannot be driven here, or undefined when it can. */
export function ptyUnavailable() {
  if (scriptOk === undefined) {
    const r = spawnSync('script', ['--version'], { encoding: 'utf8' });
    scriptOk = r.status === 0 && /util-linux/.test(`${r.stdout}${r.stderr}`);
  }
  return scriptOk ? undefined : 'util-linux script(1) is not on PATH, and it is what drives an interactive program through a pseudo-terminal here';
}

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** Terminal output as plain text: no escape sequences, no whitespace. */
export function flatten(raw) {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?<>=!]*[ -/]*[@-~]/g, '')
    .replace(/\x1bP[^\x1b]*\x1b\\/g, '')
    .replace(/\x1b[()*+][0-9A-Za-z]/g, '')
    .replace(/\x1b[=>78DEHMNOZc]/g, '')
    .replace(/[\x00-\x1f\x7f\s]+/g, '');
}

/** Named keys, as the bytes a terminal sends. */
export const KEY = {
  enter: '\r',
  down: '\x1b[B',
  up: '\x1b[A',
  esc: '\x1b',
  ctrlC: '\x03',
  ctrlD: '\x04',
};

/**
 * Start `cmd args` on a pty of `rows` x `cols`. Returns a handle whose
 * `waitFor(re)` resolves true once the screen text written since the last
 * successful wait matches, false on timeout or exit.
 */
export function startPty(cmd, args, { cwd, env, rows = 40, cols = 120 } = {}) {
  assertNoProductionTarget(cmd, args, env);
  const inner = `stty rows ${rows} cols ${cols} 2>/dev/null; exec ${[cmd, ...args].map(q).join(' ')}`;
  // -e: script exits with the child's status. -f: flush output as it comes.
  // Its own session makes the whole tree killable as one group.
  const child = spawn('script', ['-q', '-f', '-e', '-c', inner, '/dev/null'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  let raw = '';
  let mark = 0;
  const started = Date.now();
  const onData = (d) => { raw += d.toString('utf8'); };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.stdin.on('error', () => {});
  let exit;
  const exited = new Promise((resolve) => {
    child.on('close', (code, signal) => { exit = { code, signal, ms: Date.now() - started }; resolve(exit); });
    child.on('error', (err) => { exit = { code: null, signal: null, error: String(err), ms: Date.now() - started }; resolve(exit); });
  });
  const handle = {
    pid: child.pid,
    get raw() { return raw; },
    get exit() { return exit; },
    exited,
    /** Everything shown so far, flattened. */
    text() { return flatten(raw); },
    /** Wait for `re` in what was shown since the last successful wait. */
    async waitFor(re, timeoutMs = 30_000) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        if (re.test(flatten(raw.slice(mark)))) { mark = raw.length; return true; }
        if (exit || Date.now() > until) return false;
        await delay(100);
      }
    },
    /** Type text, a character run at a time, the way a paste arrives. */
    async type(text) {
      if (!exit) child.stdin.write(text);
      await delay(150);
    },
    async press(key, times = 1) {
      for (let i = 0; i < times; i++) {
        if (!exit) child.stdin.write(KEY[key] ?? key);
        await delay(250);
      }
    },
    /** Wait for the program to exit on its own; resolves the exit or undefined. */
    async waitExit(timeoutMs = 30_000) {
      return Promise.race([exited, delay(timeoutMs).then(() => undefined)]);
    },
    /** Kill the whole tree the pty started. */
    kill(signal = 'SIGKILL') {
      try { process.kill(-child.pid, signal); } catch { /* gone */ }
    },
  };
  return handle;
}
