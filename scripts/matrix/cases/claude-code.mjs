/**
 * Claude Code, the real binary: the `claude` already on PATH, signed in by
 * its owner. Its model calls go to the real Anthropic API through that
 * existing sign-in, so these cases need a signed-in claude, spend a few real
 * tokens on the cheapest model, and are marked `requires: claude-login`: they
 * are reported as SKIP where claude is missing or signed out, and run under
 * CI only with --with claude-login.
 *
 * The matrix never reads the sign-in. claude runs with the real HOME because
 * that is where its credentials live, but with `--setting-sources project`,
 * so the only settings it loads are the throwaway project's, which is where
 * `aer-hooks install claude-code --dir <project> --env-file <file>` wires
 * the hooks. The hooks record to a local sink named only in that file.
 *
 * Network: claude's traffic goes through an allowlisting proxy that opens a
 * tunnel to api.anthropic.com and nothing else; the hooks inherit the same
 * proxy, so a hook that tried to reach the AER API would be refused there.
 * The hooks' own state goes to the case's temp dirs, not the real HOME.
 *
 * Covered: `claude -p` headless as the installer wires it, the same with the
 * SessionEnd timeout key removed against an API as slow as the real one (the
 * print-mode kill the detached session-end worker exists for), and the
 * interactive TUI through a pseudo-terminal, both ways.
 */
import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, delimiter, basename } from 'node:path';
import { homedir } from 'node:os';
import { randomInt } from 'node:crypto';
import { assertNoCanaries } from '../lib/harness.mjs';
import { run, strippedPath, PRODUCTION_HOST } from '../lib/proc.mjs';
import { startAllowProxy } from '../lib/allow-proxy.mjs';
import { startPty, ptyUnavailable } from '../lib/pty.mjs';
import {
  HOOKS_PKG, identity, writeEnvFile, installHooks, completes, byType, phases,
  until, realApiLatency, assertOneCompletedRecord, killByCwd,
} from '../lib/hooks-e2e.mjs';

/** The cheapest current model: a case costs a few thousand input tokens. */
export const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_HOSTS = ['api.anthropic.com'];

let versionOnce;
function claudeVersion(env) {
  if (!versionOnce) {
    versionOnce = run('claude', ['--version'], { timeoutMs: 30_000 }).then((r) => {
      const v = r.stdout.trim().split(/\s+/)[0];
      if (r.code === 0 && v && env.thirdParty) env.thirdParty['claude-code'] = v;
      return v;
    });
  }
  return versionOnce;
}

/**
 * Canaries a real model will handle without comment. The matrix's CANARY_*
 * markers, or any token with a random hex tail, read to a model like planted
 * tracking strings and it may refuse the task; so each canary here is two
 * ordinary words picked at random, unique enough that none can turn up in a
 * sink by chance.
 */
const WORDS_A = ['amber', 'silver', 'quiet', 'hollow', 'copper', 'misty', 'velvet', 'sunlit', 'frosted', 'gilded', 'russet', 'pale'];
const WORDS_B = ['falcon', 'meadow', 'harbor', 'willow', 'lantern', 'thistle', 'orchard', 'glacier', 'heron', 'juniper', 'quarry', 'bramble'];
function plainCanaries() {
  const used = new Set();
  const word = () => {
    for (;;) {
      const w = WORDS_A[randomInt(WORDS_A.length)] + WORDS_B[randomInt(WORDS_B.length)] + WORDS_B[randomInt(WORDS_B.length)];
      if (!used.has(w)) { used.add(w); return w; }
    }
  };
  return {
    prompt: word(),
    args: word(),
    result: word(),
    file: word(),
    secret: word(),
    all() { return [this.prompt, this.args, this.result, this.file, this.secret]; },
  };
}

/**
 * The prompt: a canary in every place a body could leak from, the prompt
 * itself, the shell line, the file the shell reads (input.txt holds
 * k.result), the file the model writes and the answer it gives.
 */
function prompt(k) {
  return `In this project (codename ${k.prompt}) run this shell command: cat input.txt && echo ${k.args} && curl -s -m 2 -o /dev/null https://example.com/ ; `
    + `then create a file named out.txt containing the text ${k.file} . Reply "done" when finished.`;
}

/** Says what the directory is, the way a real repository's CLAUDE.md would. */
const FIXTURE_NOTES = '# Fixture project\n\nThis directory is a scratch fixture for exercising editor tooling. '
  + 'Running the shell commands and creating the files the user asks for here is expected and safe; '
  + 'example.com is the reserved documentation domain.\n';

/**
 * A throwaway project with the hooks installed into its .claude/settings.json,
 * the credential file, the proxy and the env claude runs with.
 */
async function wiredProject(c, { baseUrl, k, withoutTimeout = false }) {
  const proj = c.tmp('cc-proj-');
  writeFileSync(join(proj, 'input.txt'), `${k.result}\n`);
  writeFileSync(join(proj, 'CLAUDE.md'), FIXTURE_NOTES);
  // claude keeps a transcript per project under the real HOME. Only this
  // case's own directory, named after its unique temp path, is removed.
  const transcripts = join(homedir(), '.claude', 'projects', proj.replace(/[^A-Za-z0-9]/g, '-'));
  c.cleanup(() => {
    if (basename(transcripts).includes('aer-matrix-') && existsSync(transcripts)) rmSync(transcripts, { recursive: true, force: true });
  });

  const hookHome = c.home();
  const id = identity();
  const envFile = writeEnvFile(join(hookHome, '.config', 'aer'), { ...id, AER_BASE_URL: baseUrl });
  await installHooks(c, 'claude-code', { env: c.env(hookHome), envFile, dir: proj, cwd: proj });
  const settingsFile = join(proj, '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  c.assert.equal(settings.hooks?.SessionEnd?.[0]?.hooks?.[0]?.timeout, 15, 'the installer gives SessionEnd its own timeout');
  if (withoutTimeout) {
    // As a hand-written or older registration has it: the 1.5 s default.
    for (const groups of Object.values(settings.hooks)) for (const g of groups) for (const h of g.hooks) delete h.timeout;
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  }

  const proxy = await startAllowProxy(ANTHROPIC_HOSTS);
  c.cleanup(() => proxy.close());
  const env = {
    // The real HOME, for claude's own sign-in; nothing else of the caller's.
    HOME: homedir(),
    USER: process.env.USER ?? '',
    LANG: process.env.LANG ?? 'C.UTF-8',
    TERM: 'xterm-256color',
    PATH: [dirname(process.execPath), ...strippedPath()].join(delimiter),
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    // The hooks' state and the session-end worker's log stay in the case.
    XDG_CACHE_HOME: join(hookHome, '.cache'),
    XDG_STATE_HOME: join(hookHome, '.local', 'state'),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    ...proxy.env(),
  };
  return { proj, env, id, proxy, hookHome };
}

const CLAUDE_ARGS = ['--model', CLAUDE_MODEL, '--setting-sources', 'project', '--allowedTools', 'Bash', 'Write', '--permission-mode', 'acceptEdits'];

/** What a completed Claude Code run records. */
function assertClaudeRun(c, sink, { proj, k, proxy }) {
  for (const p of ['session_start', 'turn_start', 'turn_end', 'session_end']) c.assert.ok(phases(sink).includes(p), `phase ${p} missing (${phases(sink)})`);
  const started = byType(sink, 'tool.started').map((e) => e.payload.tool);
  c.assert.ok(started.includes('Bash') && started.includes('Write'), `tool.started: ${started}`);
  const execs = byType(sink, 'process.exec').map((e) => e.payload.command);
  for (const p of ['cat', 'curl', 'echo']) c.assert.ok(execs.includes(p), `process.exec ${p} missing: ${execs}`);
  const hosts = byType(sink, 'network.connect').map((e) => e.payload.host);
  c.assert.ok(hosts.includes('example.com'), `the host curl was pointed at: ${hosts}`);
  const written = byType(sink, 'file.written').map((e) => e.payload.path);
  c.assert.ok(written.includes(join(proj, 'out.txt')), `file.written: ${written}`);
  // Model and token counts from the transcript, never its text.
  const llm = byType(sink, 'llm.completed');
  c.assert.ok(llm.length >= 1, 'no llm.completed from the transcript');
  for (const e of llm) {
    c.assert.ok(String(e.payload.model).startsWith('claude-haiku-4-5'), `llm model ${e.payload.model}`);
    c.assert.ok(e.payload.input_tokens > 0 && e.payload.output_tokens > 0, `token counts ${JSON.stringify(e.payload)}`);
  }
  assertNoCanaries(sink.allText(), k);
  c.assert.ok(!proxy.refused.some((r) => r.target.includes(PRODUCTION_HOST)), 'something tried to reach the AER API');
}

// ---------------------------------------------------------------------------

export default function register(registry, env) {
  const t = registry.suite('claude-code', `${HOOKS_PKG} in the signed-in claude on PATH`);

  const cccase = (title, fn, { pty = false, timeoutMs = 360_000 } = {}) => t.case(title, async (c) => {
    if (pty) {
      const why = ptyUnavailable();
      if (why) return { skip: why };
    }
    const v = await claudeVersion(env);
    c.note(`claude ${v}, model ${CLAUDE_MODEL}`);
    return fn(c);
  }, { timeoutMs, requires: 'claude-login' });

  for (const withoutTimeout of [false, true]) {
    const title = withoutTimeout
      ? 'claude -p with the SessionEnd timeout key removed, against an API as slow as the real one: the record still completes'
      : 'claude -p as the installer wires it: one completed record with programs, host, file, model and tokens, bodies-off';
    cccase(title, async (c) => {
      const sink = await c.sink();
      if (withoutTimeout) realApiLatency(sink);
      const k = plainCanaries();
      const w = await wiredProject(c, { baseUrl: sink.url, k, withoutTimeout });
      const r = await c.run('claude', ['-p', ...CLAUDE_ARGS, prompt(k)], { cwd: w.proj, env: w.env, timeoutMs: 240_000 });
      c.assert.ok(!r.timedOut, 'claude -p hung');
      c.assert.exit(r, 0, 'claude -p');
      c.assert.ok(existsSync(join(w.proj, 'out.txt')), `the model did not write out.txt; it said: ${r.stdout.trim().slice(0, 300)}`);
      const exitedAt = Date.now();
      await assertOneCompletedRecord(c, sink, { id: w.id, harness: 'claude-code', waitMs: withoutTimeout ? 75_000 : 30_000 });
      assertClaudeRun(c, sink, { proj: w.proj, k, proxy: w.proxy });
      c.note(`claude -p took ${r.ms} ms; the record completed within ${Math.max(0, completes(sink)[0].at - exitedAt)} ms of its exit`);
    });
  }

  for (const withoutTimeout of [false, true]) {
    const title = withoutTimeout
      ? 'claude TUI with the SessionEnd timeout key removed, against a slow API: one prompt, /exit, and the record completes'
      : 'claude TUI as the installer wires it: trust the folder, one prompt that runs a command and writes a file, /exit, and the record completes';
    cccase(title, async (c) => {
      const sink = await c.sink();
      if (withoutTimeout) realApiLatency(sink);
      const k = plainCanaries();
      const w = await wiredProject(c, { baseUrl: sink.url, k, withoutTimeout });
      const pty = startPty('claude', CLAUDE_ARGS, { cwd: w.proj, env: w.env });
      c.cleanup(async () => { pty.kill(); killByCwd(w.proj); await pty.waitExit(5000); });
      const screen = () => pty.text().slice(-1500);
      // A new folder is asked about once; the answer is kept by claude.
      c.assert.ok(await pty.waitFor(/Itrustthisfolder|ClaudeCodev\d/, 60_000), `claude never showed its prompt: ${screen()}`);
      if (/Itrustthisfolder/.test(pty.text())) {
        // The dialog takes a moment to accept keys, and an Enter sent while
        // it is still drawing is lost.
        await new Promise((r) => setTimeout(r, 1000));
        await pty.press('down');
        c.assert.ok(await pty.waitFor(/❯Yes,Itrustthisfolder/, 10_000), `could not select the trust answer: ${screen()}`);
        await new Promise((r) => setTimeout(r, 1000));
        await pty.press('enter');
        c.assert.ok(await pty.waitFor(/ClaudeCodev\d/, 30_000), `no prompt after the trust question: ${screen()}`);
      }
      await new Promise((r) => setTimeout(r, 2500));
      await pty.type(prompt(k));
      await new Promise((r) => setTimeout(r, 500));
      await pty.press('enter');
      c.assert.ok(await until(() => phases(sink).includes('turn_end'), 180_000), `the turn never ended: ${screen()}`);
      c.assert.ok(existsSync(join(w.proj, 'out.txt')), `the model did not write out.txt: ${screen()}`);
      await new Promise((r) => setTimeout(r, 1500));
      await pty.type('/exit');
      await new Promise((r) => setTimeout(r, 700));
      await pty.press('enter');
      const exit = await pty.waitExit(30_000);
      c.assert.ok(exit, `claude did not exit on /exit: ${screen()}`);
      c.assert.equal(exit.code, 0, 'claude exit status');
      const exitedAt = Date.now();
      await assertOneCompletedRecord(c, sink, { id: w.id, harness: 'claude-code', waitMs: withoutTimeout ? 75_000 : 30_000 });
      assertClaudeRun(c, sink, { proj: w.proj, k, proxy: w.proxy });
      c.note(`the record completed within ${Math.max(0, completes(sink)[0].at - exitedAt)} ms of /exit`);
    }, { pty: true });
  }
}
