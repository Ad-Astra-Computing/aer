/**
 * OpenAI Codex CLI, the real binary: `@openai/codex` installed from npm at a
 * pinned version, the AER hooks wired with `aer-hooks install codex
 * --env-file <file>` exactly as the aer-hooks README documents it, and Codex
 * pointed at a local model server that speaks the OpenAI Responses protocol
 * (Codex supports no other wire protocol for a custom provider). The server
 * answers with tool calls, so Codex itself runs a shell command and writes a
 * file through apply_patch; the hooks record what it did.
 *
 * Both ways a person runs Codex are covered: `codex exec` headless, and the
 * interactive TUI driven through a pseudo-terminal, with and without the
 * background app-server daemon the TUI starts by default.
 *
 * Hook trust. Codex skips a hook nobody has trusted, silently. Headless, the
 * documented switch for automation is --dangerously-bypass-hook-trust. In the
 * TUI the startup review is answered the way a person does ("Trust all and
 * continue"), and the case checks Codex recorded that trust in config.toml.
 *
 * Hermetic: a throwaway HOME (short, since the TUI daemon puts a unix socket
 * under ~/.codex), the provider key is a fake, and every non-loopback
 * connection meets the matrix's blackhole proxy, which Codex honours.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { canaries, assertNoCanaries } from '../lib/harness.mjs';
import { deadPort } from '../lib/sink.mjs';
import { installInto } from '../lib/install.mjs';
import { run } from '../lib/proc.mjs';
import { startPty, ptyUnavailable } from '../lib/pty.mjs';
import {
  HOOKS_PKG, identity, writeEnvFile, installHooks, opens, completes, byType, phases,
  completed, until, realApiLatency, assertOneCompletedRecord, shortTmp, killByMarker, killByCwd,
} from '../lib/hooks-e2e.mjs';

/** The version under test. */
export const CODEX_PINS = { '@openai/codex': '0.162.0' };

// A model Codex knows, so it offers apply_patch; any other name gets a
// fallback tool set without it. Served by the local provider, never OpenAI.
const MODEL = 'gpt-5.5';
const PROVIDER_ID = 'mx';
const USAGE = { input: 101, output: 13 };

// ---------------------------------------------------------------------------
// The model server. One turn: run a shell line, then write a file through
// apply_patch, then answer. A request without tools is answered in text.

async function startModelServer(c, k, { command }) {
  const hits = [];
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const text = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    const tools = (Array.isArray(body.tools) ? body.tools : []).map((t) => t?.name ?? t?.type).filter(Boolean);
    const input = Array.isArray(body.input) ? body.input : [];
    const shellDone = input.filter((i) => i?.type === 'function_call_output').length;
    const patchDone = input.filter((i) => i?.type === 'custom_tool_call_output').length;
    hits.push({ url: req.url, body: text, tools, shellDone, patchDone });
    if (req.method !== 'POST' || !req.url.endsWith('/responses')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    const n = hits.length;
    let item;
    if (shellDone === 0 && tools.includes('exec_command')) {
      item = { type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: 'exec_command', arguments: JSON.stringify({ cmd: command }) };
    } else if (patchDone === 0 && tools.includes('apply_patch')) {
      item = { type: 'custom_tool_call', id: `ctc_${n}`, call_id: `call_${n}`, name: 'apply_patch', input: `*** Begin Patch\n*** Add File: notes.txt\n+${k.file}\n*** End Patch\n` };
    } else {
      item = { type: 'message', id: `msg_${n}`, role: 'assistant', content: [{ type: 'output_text', text: `Done. ${k.result}` }] };
    }
    const id = `resp_${n}`;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (type, obj) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`);
    send('response.created', { response: { id } });
    send('response.output_item.added', { output_index: 0, item });
    send('response.output_item.done', { output_index: 0, item });
    send('response.completed', {
      response: {
        id,
        usage: {
          input_tokens: USAGE.input,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: USAGE.output,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: USAGE.input + USAGE.output,
        },
      },
    });
    res.end();
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  c.cleanup(() => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }));
  return { hits, url: `http://127.0.0.1:${server.address().port}` };
}

// ---------------------------------------------------------------------------
// The install: Codex itself, once per run.

let installed;
function codexInstall(env) {
  if (!installed) {
    installed = (async () => {
      const dir = join(env.workRoot, 'codex');
      mkdirSync(dir, { recursive: true });
      const spec = `@openai/codex@${CODEX_PINS['@openai/codex']}`;
      await installInto(dir, { '@openai/codex': { spec } }, { log: env.log, npmEnv: env.npmEnv, retryMinutes: 1, registry: true });
      const bin = join(dir, 'node_modules', '.bin', 'codex');
      if (!existsSync(bin)) throw new Error(`${spec} installed no codex bin`);
      const v = await run(bin, ['--version'], { timeoutMs: 30_000 });
      const got = v.stdout.trim().split(/\s+/).pop();
      if (got !== CODEX_PINS['@openai/codex']) throw new Error(`${spec} reports version ${JSON.stringify(v.stdout.trim())}`);
      if (env.thirdParty) Object.assign(env.thirdParty, CODEX_PINS);
      return { bin };
    })().catch((err) => ({ skip: `could not install Codex from npm: ${String(err.message ?? err).split('\n')[0]}` }));
  }
  return installed;
}

// ---------------------------------------------------------------------------
// One wired project: HOME with ~/.codex/config.toml pointing at the model
// server, the credential file, `aer-hooks install codex`, and the project
// directory Codex works in.

async function wiredProject(c, { baseUrl, k, command, codexHomeVar = false }) {
  const home = shortTmp(c, 'mxcx-');
  // Whatever Codex leaves running (the TUI's daemon) dies with the case.
  c.cleanup(() => { killByMarker(home); });
  const proj = join(home, 'proj');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, 'input.txt'), `${k.file}\n`);
  const model = await startModelServer(c, k, { command });
  // With CODEX_HOME set, Codex reads its config there instead of ~/.codex.
  const codexHome = codexHomeVar ? join(home, 'codex-home') : join(home, '.codex');
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, 'config.toml'), [
    `model = "${MODEL}"`,
    `model_provider = "${PROVIDER_ID}"`,
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    'check_for_update_on_startup = false',
    '',
    `[model_providers.${PROVIDER_ID}]`,
    'name = "Matrix"',
    `base_url = "${model.url}/v1"`,
    'wire_api = "responses"',
    'env_key = "MX_PROVIDER_KEY"',
    '',
    // The TUI offers a newer model once per install; this says it was seen.
    '[notice.model_migrations]',
    `"${MODEL}" = "gpt-6-sol"`,
    '',
    `[projects."${proj}"]`,
    'trust_level = "trusted"',
    '',
  ].join('\n'));

  const id = identity();
  const envFile = writeEnvFile(join(home, '.config', 'aer'), { ...id, AER_BASE_URL: baseUrl });
  const env = c.env(home, { MX_PROVIDER_KEY: `sk-${k.secret}`, TERM: 'xterm-256color', ...(codexHomeVar ? { CODEX_HOME: codexHome } : {}) });
  env.PATH = [dirname(process.execPath), ...env.PATH.split(delimiter)].join(delimiter);
  await installHooks(c, 'codex', { env, envFile });
  const hooksJson = readFileSync(join(codexHome, 'hooks.json'), 'utf8');
  c.assert.includes(hooksJson, '--env-file', 'the wired command names the credential file');
  c.assert.excludes(hooksJson, id.AER_API_KEY, 'the key is in the hooks config');
  return { home, proj, env, id, model, codexHome };
}

/** The shell line the model asks for: a read, a network client and an echo. */
const shellLine = (k) => `cat input.txt && curl -s -m 2 https://example.com/${k.path}?q=${k.query}; echo ${k.args}`;

/** What a completed Codex run records, whichever way it was run. */
function assertCodexRun(c, sink, { proj, k }) {
  const start = byType(sink, 'collector.report').find((e) => e.payload?.phase === 'session_start');
  c.assert.equal(start?.payload?.model, MODEL, 'model on the session_start marker');
  for (const p of ['session_start', 'turn_start', 'turn_end', 'session_end']) c.assert.ok(phases(sink).includes(p), `phase ${p} missing (${phases(sink)})`);
  const started = byType(sink, 'tool.started').map((e) => e.payload.tool);
  c.assert.equal(started.join(','), 'Bash,apply_patch', 'tool.started');
  c.assert.equal(byType(sink, 'tool.completed').length, 2, 'tool.completed');
  const execs = byType(sink, 'process.exec').map((e) => e.payload.command);
  c.assert.equal(execs.join(','), 'cat,curl,echo', 'process.exec programs');
  const hosts = byType(sink, 'network.connect').map((e) => e.payload.host);
  c.assert.equal(hosts.join(','), 'example.com', 'the host curl was pointed at');
  const written = byType(sink, 'file.written').map((e) => e.payload.path);
  c.assert.equal(written.join(','), join(proj, 'notes.txt'), 'file.written from apply_patch');
  // Codex's hooks carry the model but no token counts, and aer-hooks reads no
  // Codex rollout, so there is no llm.completed to check here.
  assertNoCanaries(sink.allText(), k);
}

/** The model server saw Codex really run both tools. */
function assertToolsRan(c, model, proj, k) {
  const withTools = model.hits.filter((h) => h.tools.length > 0);
  c.assert.ok(withTools.length >= 3, `model requests with tools: ${withTools.length}`);
  c.assert.ok(withTools.some((h) => h.shellDone === 1 && h.body.includes(k.file)), 'the shell output was fed back to the model');
  c.assert.equal(readFileSync(join(proj, 'notes.txt'), 'utf8').trim(), k.file, 'apply_patch wrote the file');
}

const EXEC_ARGS = (prompt) => ['exec', '--skip-git-repo-check', '--dangerously-bypass-hook-trust', prompt];

// ---------------------------------------------------------------------------

export default function register(registry, env) {
  const t = registry.suite('codex', `${HOOKS_PKG} in @openai/codex@${CODEX_PINS['@openai/codex']}`);

  const cxcase = (title, fn, { pty = false, timeoutMs = 300_000 } = {}) => t.case(title, async (c) => {
    if (pty) {
      const why = ptyUnavailable();
      if (why) return { skip: why };
    }
    const cx = await codexInstall(env);
    if (cx.skip) return cx;
    c.note(Object.entries(CODEX_PINS).map(([n, v]) => `${n}@${v}`).join(', '));
    return fn(c, cx);
  }, { timeoutMs });

  cxcase('codex exec: one completed record with the shell line, programs, host, patched file and model, bodies-off', async (c, cx) => {
    const sink = await c.sink();
    const k = canaries('CXEXEC');
    const w = await wiredProject(c, { baseUrl: sink.url, k, command: shellLine(k) });
    const r = await c.run(cx.bin, EXEC_ARGS(`Show input.txt and note it. ${k.prompt}`), { cwd: w.proj, env: w.env, timeoutMs: 120_000, killGroup: true });
    c.assert.ok(!r.timedOut, 'codex exec hung');
    c.assert.exit(r, 0, 'codex exec');
    c.assert.includes(r.stdout, k.result, 'the model answer on stdout');
    assertToolsRan(c, w.model, w.proj, k);
    await assertOneCompletedRecord(c, sink, { id: w.id, harness: 'codex' });
    assertCodexRun(c, sink, { proj: w.proj, k });
    c.note(`${sink.events().length} events; codex exec exited after ${r.ms} ms`);
  });

  cxcase('codex exec with CODEX_HOME set: the installer wires the hooks where Codex reads them, and the run records', async (c, cx) => {
    const sink = await c.sink();
    const k = canaries('CXHOME');
    const w = await wiredProject(c, { baseUrl: sink.url, k, command: shellLine(k), codexHomeVar: true });
    c.assert.ok(!existsSync(join(w.home, '.codex', 'hooks.json')), 'the installer wrote ~/.codex/hooks.json, which Codex does not read here');
    const r = await c.run(cx.bin, EXEC_ARGS(`Show input.txt and note it. ${k.prompt}`), { cwd: w.proj, env: w.env, timeoutMs: 120_000, killGroup: true });
    c.assert.exit(r, 0, 'codex exec');
    await assertOneCompletedRecord(c, sink, { id: w.id, harness: 'codex' });
    assertCodexRun(c, sink, { proj: w.proj, k });
  });

  cxcase('codex exec against an API as slow as the real one: Codex is not held up and the record still completes after it exits', async (c, cx) => {
    // Codex bounds its SessionEnd hooks and kills what outlives them; the
    // hook hands the rest to a detached worker, which must finish the job.
    const sink = await c.sink();
    realApiLatency(sink);
    const k = canaries('CXSLOW');
    const w = await wiredProject(c, { baseUrl: sink.url, k, command: shellLine(k) });
    const r = await c.run(cx.bin, EXEC_ARGS(`Show input.txt and note it. ${k.prompt}`), { cwd: w.proj, env: w.env, timeoutMs: 180_000, killGroup: true });
    c.assert.ok(!r.timedOut, 'codex exec hung');
    c.assert.exit(r, 0, 'codex exec');
    c.assert.includes(r.stdout, k.result, 'the model answer on stdout');
    const exitedAt = Date.now();
    await assertOneCompletedRecord(c, sink, { id: w.id, harness: 'codex', waitMs: 75_000 });
    assertCodexRun(c, sink, { proj: w.proj, k });
    const completedAt = completes(sink)[0].at;
    c.note(`codex exec took ${r.ms} ms; the record completed within ${Math.max(0, completedAt - exitedAt)} ms of its exit`);
  }, { timeoutMs: 420_000 });

  cxcase('codex exec with the AER API down: Codex answers, exits on time and reaches nothing else', async (c, cx) => {
    const k = canaries('CXDOWN');
    const port = await deadPort();
    const w = await wiredProject(c, { baseUrl: `http://127.0.0.1:${port}`, k, command: shellLine(k) });
    const r = await c.run(cx.bin, EXEC_ARGS(`Show input.txt and note it. ${k.prompt}`), { cwd: w.proj, env: w.env, timeoutMs: 120_000, killGroup: true });
    c.assert.ok(!r.timedOut, 'codex exec hung with the AER API unreachable');
    c.assert.exit(r, 0, 'codex exec');
    c.assert.includes(r.stdout, k.result, 'the model answer on stdout');
    c.assert.ok(r.ms < 60_000, `codex exec took ${r.ms} ms`);
    c.assert.equal(readFileSync(join(w.proj, 'notes.txt'), 'utf8').trim(), k.file, 'apply_patch still wrote the file');
    c.note(`exit after ${r.ms} ms`);
  });

  cxcase('codex exec without hook trust: Codex skips the untrusted hooks and nothing is recorded (the README warning)', async (c, cx) => {
    const sink = await c.sink();
    const k = canaries('CXTRUST');
    const w = await wiredProject(c, { baseUrl: sink.url, k, command: shellLine(k) });
    const r = await c.run(cx.bin, ['exec', '--skip-git-repo-check', `Show input.txt and note it. ${k.prompt}`], { cwd: w.proj, env: w.env, timeoutMs: 120_000, killGroup: true });
    c.assert.exit(r, 0, 'codex exec');
    c.assert.includes(r.stdout, k.result, 'the model answer on stdout');
    await new Promise((res) => setTimeout(res, 2000));
    c.assert.equal(sink.requests.length, 0, 'an untrusted hook reached the sink');
    c.note(`codex said: ${(r.stderr.match(/[^\n]*hook[^\n]*/i) ?? ['nothing about hooks'])[0].slice(0, 200)}`);
  });

  // The TUI. Codex 0.158 starts a background app-server daemon by default;
  // the thread lives there, so leaving the TUI only disconnects from it. The
  // daemon unloads the idle thread about a minute later and that is when
  // SessionEnd fires. With --no-daemon the thread ends with the TUI.
  for (const mode of ['daemon', 'no-daemon']) {
    cxcase(`codex TUI (${mode}): trust the hooks at the startup review, run one prompt, /exit, and the record completes`, async (c, cx) => {
      const sink = await c.sink();
      const k = canaries(mode === 'daemon' ? 'CXTUI' : 'CXTUIND');
      const w = await wiredProject(c, { baseUrl: sink.url, k, command: shellLine(k) });
      const args = mode === 'daemon' ? [] : ['--no-daemon'];
      const pty = startPty(cx.bin, args, { cwd: w.proj, env: w.env });
      c.cleanup(async () => { pty.kill(); killByCwd(w.proj); await pty.waitExit(5000); });
      const screen = () => pty.text().slice(-1500);
      c.assert.ok(await pty.waitFor(/Trustallandcontinue/, 60_000), `no hook review at startup: ${screen()}`);
      await pty.press('down');
      await pty.press('enter');
      c.assert.ok(await pty.waitFor(/AskCodex/, 30_000), `no prompt after the review: ${screen()}`);
      await new Promise((r) => setTimeout(r, 1000));
      await pty.type(`Show input.txt and note it. ${k.prompt}`);
      await pty.press('enter');
      c.assert.ok(await until(() => phases(sink).includes('turn_end'), 90_000), `the turn never ended: ${screen()}`);
      c.assert.ok(await pty.waitFor(new RegExp(k.result), 15_000), `no answer on screen: ${screen()}`);
      await new Promise((r) => setTimeout(r, 1000));
      await pty.type('/exit');
      await pty.press('enter');
      const exit = await pty.waitExit(30_000);
      c.assert.ok(exit, `the TUI did not exit on /exit: ${screen()}`);
      c.assert.equal(exit.code, 0, 'TUI exit status');
      const exitedAt = Date.now();

      // The review recorded trust for every AER hook, against its command.
      // Known Codex TUI gap (9 Oct): the startup review trusts
      // permission_request but not its sibling permission_denied, so a
      // Codex TUI user who does the normal "Trust all and continue" never
      // gets approval.decided(denied) recorded; codex exec bypasses trust
      // entirely so it is unaffected. Asserted by name so any OTHER hook
      // silently losing trust is still caught as a real regression.
      const cfg = readFileSync(join(w.codexHome, 'config.toml'), 'utf8');
      const trustedKeys = [...cfg.matchAll(/\[hooks\.state\."[^"]*:([a-z_]+):\d+:\d+"\]/g)].map((m) => m[1]);
      for (const key of [
        'session_start', 'user_prompt_submit', 'pre_tool_use', 'post_tool_use',
        'stop', 'subagent_start', 'subagent_stop', 'session_end', 'permission_request',
      ]) {
        c.assert.ok(trustedKeys.includes(key), `${key} not trusted by the startup review (${trustedKeys})`);
      }
      if (!trustedKeys.includes('permission_denied')) {
        c.note('known gap: permission_denied was not trusted by the startup review');
      }

      assertToolsRan(c, w.model, w.proj, k);
      await assertOneCompletedRecord(c, sink, { id: w.id, harness: 'codex', waitMs: mode === 'daemon' ? 150_000 : 30_000 });
      assertCodexRun(c, sink, { proj: w.proj, k });
      c.note(`the record completed within ${Math.max(0, completes(sink)[0].at - exitedAt)} ms of /exit`);
    }, { pty: true, timeoutMs: 420_000 });
  }
}
