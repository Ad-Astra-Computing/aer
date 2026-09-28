/**
 * Antigravity CLI, the real binary: the `agy` on PATH (nixpkgs
 * antigravity-cli; there is no npm package to pin it from, so the version is
 * checked against the one these cases were written for and recorded in the
 * report). The AER hooks are wired with `aer-hooks install antigravity
 * --env-file <file>`.
 *
 * No Google account is needed. agy has a direct Gemini API mode:
 * `modelProvider: "gemini"` in its settings.json, GEMINI_API_KEY, and
 * GOOGLE_GEMINI_BASE_URL for a custom endpoint. The key is a fake and the
 * endpoint is a local server speaking the Gemini streamGenerateContent
 * protocol, which answers with function calls, so agy itself runs a shell
 * command, reads a file and writes one; the hooks record what it did.
 *
 * Both modes are covered: `agy -p` headless, and the interactive TUI through a
 * pseudo-terminal, which on a fresh HOME first walks through agy's own
 * onboarding (colour scheme, terms) and asks to trust the folder, as it does
 * for a person. Every non-loopback connection meets the blackhole proxy.
 */
import { createServer } from 'node:http';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { canaries, assertNoCanaries } from '../lib/harness.mjs';
import { deadPort } from '../lib/sink.mjs';
import { run } from '../lib/proc.mjs';
import { startPty, ptyUnavailable } from '../lib/pty.mjs';
import {
  HOOKS_PKG, identity, writeEnvFile, installHooks, opens, completes, completed, byType, phases,
  until, realApiLatency, assertOneCompletedRecord, killByCwd,
} from '../lib/hooks-e2e.mjs';

/** The agy release these cases were written against. */
export const AGY_TESTED = '1.2.6';
const USAGE = { promptTokenCount: 101, candidatesTokenCount: 13, totalTokenCount: 114 };

// ---------------------------------------------------------------------------
// The model server. One turn: run a shell line, read a file, write a file,
// answer. agy also asks a small model for titles and the like, without the
// tools; those get a short text answer.

async function startModelServer(c, k, { proj, command }) {
  const hits = [];
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const text = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    const tools = (Array.isArray(body.tools) ? body.tools : []).flatMap((t) => (t?.functionDeclarations ?? []).map((f) => f?.name));
    const done = (Array.isArray(body.contents) ? body.contents : []).flatMap((m) => m?.parts ?? []).filter((p) => p?.functionResponse).length;
    hits.push({ url: req.url, body: text, tools, done });
    if (req.method !== 'POST' || !/:(stream)?[gG]enerateContent/.test(req.url)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 404, message: 'not found' } }));
      return;
    }
    let part;
    if (tools.includes('run_command') && done === 0) {
      part = { functionCall: { name: 'run_command', args: { CommandLine: command, Cwd: proj, WaitMsBeforeAsync: 5000, toolAction: 'Run', toolSummary: 'show it' } } };
    } else if (tools.includes('view_file') && done === 1) {
      part = { functionCall: { name: 'view_file', args: { AbsolutePath: join(proj, 'input.txt'), toolAction: 'Read', toolSummary: 'read it' } } };
    } else if (tools.includes('write_to_file') && done === 2) {
      part = { functionCall: { name: 'write_to_file', args: { TargetFile: join(proj, 'out.txt'), CodeContent: `${k.file}\n`, Description: 'note it', Overwrite: true, toolAction: 'Write', toolSummary: 'write it' } } };
    } else {
      part = { text: `Done. ${k.result}` };
    }
    const resp = { candidates: [{ content: { role: 'model', parts: [part] }, finishReason: 'STOP', index: 0 }], usageMetadata: USAGE, modelVersion: 'gemini-matrix' };
    if (req.url.includes('alt=sse') || req.url.includes('streamGenerateContent')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify(resp)}\n\n`);
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(resp));
    }
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  c.cleanup(() => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }));
  return { hits, url: `http://127.0.0.1:${server.address().port}` };
}

let versionOnce;
function agyVersion(env) {
  if (!versionOnce) {
    versionOnce = run('agy', ['--version'], { timeoutMs: 30_000 }).then((r) => {
      if (r.spawnError || r.code !== 0) return { skip: 'agy (the Antigravity CLI) is not on PATH. Install it (nixpkgs antigravity-cli) to run these cases; no Google account is needed, they use its Gemini API key mode against a local server.' };
      const v = r.stdout.trim().split(/\s+/).pop();
      if (env.thirdParty) env.thirdParty['antigravity-cli'] = v;
      return { version: v };
    });
  }
  return versionOnce;
}

/** A wired HOME and project: agy's settings, the credential file, the install. */
async function wiredProject(c, { baseUrl, k, command }) {
  const home = c.home();
  const proj = c.tmp('agy-proj-');
  writeFileSync(join(proj, 'input.txt'), `${k.secret}\n`);
  const model = await startModelServer(c, k, { proj, command });
  mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
  writeFileSync(join(home, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify({ modelProvider: 'gemini' }, null, 2));
  const id = identity();
  const envFile = writeEnvFile(join(home, '.config', 'aer'), { ...id, AER_BASE_URL: baseUrl });
  const env = c.env(home, { GEMINI_API_KEY: `fake-${k.secret}`, GOOGLE_GEMINI_BASE_URL: model.url, TERM: 'xterm-256color' });
  env.PATH = [dirname(process.execPath), ...env.PATH.split(delimiter)].join(delimiter);
  await installHooks(c, 'antigravity', { env, envFile });
  return { home, proj, env, id, model };
}

const shellLine = (k) => `cat input.txt && curl -s -m 2 https://example.com/${k.path}?q=${k.query}; echo ${k.args}`;

/** What a completed agy run records. */
function assertAgyRun(c, sink, { proj, k }) {
  const start = byType(sink, 'collector.report').find((e) => e.payload?.phase === 'session_start');
  c.assert.match(start?.payload?.model ?? '', /^gemini-/, 'model on the session_start marker');
  const started = byType(sink, 'tool.started').map((e) => e.payload.tool);
  c.assert.equal(started.join(','), 'run_command,view_file,write_to_file', 'tool.started');
  c.assert.equal(byType(sink, 'tool.completed').map((e) => e.payload.is_error).join(','), 'false,false,false', 'tool outcomes');
  const execs = byType(sink, 'process.exec').map((e) => e.payload.command);
  c.assert.equal(execs.join(','), 'cat,curl,echo', 'process.exec programs');
  const hosts = byType(sink, 'network.connect').map((e) => e.payload.host);
  c.assert.equal(hosts.join(','), 'example.com', 'the host curl was pointed at');
  c.assert.equal(byType(sink, 'file.opened').map((e) => e.payload.path).join(','), join(proj, 'input.txt'), 'file.opened');
  c.assert.equal(byType(sink, 'file.written').map((e) => e.payload.path).join(','), join(proj, 'out.txt'), 'file.written');
  // agy's hooks carry the model name and no token counts.
  assertNoCanaries(sink.allText(), k);
}

function assertToolsRan(c, model, proj, k) {
  c.assert.ok(model.hits.some((h) => h.done === 1 && h.body.includes(k.secret)), 'the shell output was fed back to the model');
  c.assert.equal(readFileSync(join(proj, 'out.txt'), 'utf8').trim(), k.file, 'write_to_file wrote the file');
}

const PRINT_ARGS = (prompt) => ['--dangerously-skip-permissions', '-p', prompt];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Start the TUI on a fresh HOME and walk agy's own first run the way a person
 * does: a colour scheme, its terms, then whether to trust the folder. The
 * network guard means nothing agy might send leaves the machine.
 */
async function startAgyTui(c, w) {
  const pty = startPty('agy', ['--dangerously-skip-permissions'], { cwd: w.proj, env: w.env });
  c.cleanup(async () => { pty.kill(); killByCwd(w.proj); await pty.waitExit(5000); });
  const screen = () => pty.text().slice(-1500);
  c.assert.ok(await pty.waitFor(/Chooseyourcolorscheme/, 60_000), `no onboarding: ${screen()}`);
  await pause(1000);
  await pty.press('enter');
  c.assert.ok(await pty.waitFor(/TermsofService/, 20_000), `no terms page: ${screen()}`);
  await pause(1000);
  await pty.press('\t');
  await pty.press('\t');
  c.assert.ok(await pty.waitFor(/>Done/, 10_000), `could not reach Done: ${screen()}`);
  await pty.press('enter');
  c.assert.ok(await pty.waitFor(/Itrustthisfolder/, 20_000), `no folder trust question: ${screen()}`);
  await pause(1000);
  await pty.press('enter');
  c.assert.ok(await pty.waitFor(/forshortcuts/, 30_000), `no prompt: ${screen()}`);
  await pause(1500);
  return { pty, screen };
}

async function ask(pty, text) {
  await pty.type(text);
  await pause(500);
  await pty.press('enter');
}

async function exitTui(c, pty, screen) {
  await pause(1500);
  await pty.type('/exit');
  await pause(700);
  await pty.press('enter');
  const exit = await pty.waitExit(30_000);
  c.assert.ok(exit, `agy did not exit on /exit: ${screen()}`);
  c.assert.equal(exit.code, 0, 'agy exit status');
}

// ---------------------------------------------------------------------------

export default function register(registry, env) {
  const t = registry.suite('antigravity', `${HOOKS_PKG} in the agy (Antigravity CLI) on PATH`);

  const agcase = (title, fn, { pty = false, timeoutMs = 300_000 } = {}) => t.case(title, async (c) => {
    if (pty) {
      const why = ptyUnavailable();
      if (why) return { skip: why };
    }
    const v = await agyVersion(env);
    if (v.skip) return v;
    c.note(`agy ${v.version}${v.version === AGY_TESTED ? '' : ` (these cases were written against ${AGY_TESTED})`}`);
    return fn(c);
  }, { timeoutMs });

  agcase('agy -p: one completed record with programs, host, the file read and the file written, and the model, bodies-off', async (c) => {
    const sink = await c.sink();
    const k = canaries('AGP');
    const w = await wiredProject(c, { baseUrl: sink.url, k, command: shellLine(k) });
    const r = await c.run('agy', PRINT_ARGS(`Show input.txt and note it. ${k.prompt}`), { cwd: w.proj, env: w.env, timeoutMs: 120_000 });
    c.assert.ok(!r.timedOut, 'agy -p hung');
    c.assert.exit(r, 0, 'agy -p');
    c.assert.includes(r.stdout, k.result, 'the model answer on stdout');
    assertToolsRan(c, w.model, w.proj, k);
    await assertOneCompletedRecord(c, sink, { id: w.id, harness: 'antigravity' });
    // agy fires its tool hooks only from a matcher group; a flat entry
    // loads and never runs, and the run records no tool call at all.
    const cfg = JSON.parse(readFileSync(join(w.home, '.gemini', 'config', 'hooks.json'), 'utf8'));
    c.assert.ok(Array.isArray(cfg.aer?.PreToolUse?.[0]?.hooks), `the tool events are not a matcher group: ${JSON.stringify(cfg.aer?.PreToolUse)}`);
    assertAgyRun(c, sink, { proj: w.proj, k });
    c.note(`${sink.events().length} events; agy -p exited after ${r.ms} ms`);
  });

  agcase('agy -p against an API as slow as the real one: the record still completes after agy exits', async (c) => {
    const sink = await c.sink();
    realApiLatency(sink);
    const k = canaries('AGSLOW');
    const w = await wiredProject(c, { baseUrl: sink.url, k, command: shellLine(k) });
    const r = await c.run('agy', PRINT_ARGS(`Show input.txt and note it. ${k.prompt}`), { cwd: w.proj, env: w.env, timeoutMs: 240_000 });
    c.assert.ok(!r.timedOut, 'agy -p hung');
    c.assert.exit(r, 0, 'agy -p');
    const exitedAt = Date.now();
    await assertOneCompletedRecord(c, sink, { id: w.id, harness: 'antigravity', waitMs: 75_000 });
    assertAgyRun(c, sink, { proj: w.proj, k });
    c.note(`agy -p took ${r.ms} ms; the record completed within ${Math.max(0, completes(sink)[0].at - exitedAt)} ms of its exit`);
  }, { timeoutMs: 420_000 });

  agcase('agy -p with the AER API down: agy answers, exits on time and reaches nothing else', async (c) => {
    const k = canaries('AGDOWN');
    const port = await deadPort();
    const w = await wiredProject(c, { baseUrl: `http://127.0.0.1:${port}`, k, command: shellLine(k) });
    const r = await c.run('agy', PRINT_ARGS(`Show input.txt and note it. ${k.prompt}`), { cwd: w.proj, env: w.env, timeoutMs: 120_000 });
    c.assert.ok(!r.timedOut, 'agy -p hung with the AER API unreachable');
    c.assert.exit(r, 0, 'agy -p');
    c.assert.includes(r.stdout, k.result, 'the model answer on stdout');
    c.assert.ok(r.ms < 60_000, `agy -p took ${r.ms} ms`);
    c.note(`exit after ${r.ms} ms`);
  });

  agcase('agy TUI: first-run onboarding, trust the folder, one prompt, /exit, and the record completes', async (c) => {
    const sink = await c.sink();
    const k = canaries('AGTUI');
    const w = await wiredProject(c, { baseUrl: sink.url, k, command: shellLine(k) });
    const { pty, screen } = await startAgyTui(c, w);
    await ask(pty, `Show input.txt and note it. ${k.prompt}`);
    c.assert.ok(await until(() => phases(sink).includes('session_end') || existsSync(join(w.proj, 'out.txt')), 90_000), `the turn never ran: ${screen()}`);
    c.assert.ok(await pty.waitFor(new RegExp(k.result), 30_000), `no answer on screen: ${screen()}`);
    await exitTui(c, pty, screen);
    assertToolsRan(c, w.model, w.proj, k);
    await assertOneCompletedRecord(c, sink, { id: w.id, harness: 'antigravity' });
    assertAgyRun(c, sink, { proj: w.proj, k });
  }, { pty: true, timeoutMs: 360_000 });

  agcase('agy TUI, two turns: with no session-end event, each turn is its own completed record under one client_ref', async (c) => {
    // agy fires Stop, fully idle, at the end of every turn and starts the
    // next turn's invocations from zero, and it has no event for the end of
    // the conversation. The hook closes at that Stop, since a record left
    // open would never be sealed; the parts share the conversation's
    // client_ref so they can be read back as one run.
    const sink = await c.sink();
    const k = canaries('AGTWO');
    const w = await wiredProject(c, { baseUrl: sink.url, k, command: shellLine(k) });
    const { pty, screen } = await startAgyTui(c, w);
    await ask(pty, `Show input.txt and note it. ${k.prompt}`);
    c.assert.equal(await completed(sink, 1, 90_000), 1, `the first turn was not completed: ${screen()}`);
    await pause(1500);
    await ask(pty, `Thanks, and once more. ${k.prompt}`);
    c.assert.equal(await completed(sink, 2, 90_000), 2, `the second turn was not completed: ${screen()}`);
    await exitTui(c, pty, screen);
    const refs = opens(sink).map((r) => r.json.client_ref);
    c.assert.equal(refs.length, 2, 'records opened');
    c.assert.ok(refs[0] && refs[0] === refs[1], `client_ref differs between the parts: ${refs}`);
    c.assert.equal(byType(sink, 'tool.started').length, 3, 'the first turn\'s tools, recorded once');
    assertNoCanaries(sink.allText(), k);
  }, { pty: true, timeoutMs: 360_000 });
}
