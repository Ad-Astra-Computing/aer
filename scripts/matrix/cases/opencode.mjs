/**
 * opencode, the real binary: `opencode-ai` installed from npm at a pinned
 * version, the AER plugin wired exactly as the aer-hooks README documents it
 * (`.opencode/plugins/aer.ts` importing aerOpencodePlugin from the installed
 * @adastracomputing/aer-hooks), and `opencode run` driven non-interactively
 * against a local OpenAI-compatible model server that answers with tool
 * calls. opencode runs the tools itself; the plugin records what it did.
 *
 * Hermetic: opencode's HOME and XDG directories are the case's own, its
 * provider is the local server (no real key), its models catalogue fetch and
 * autoupdate are off, and every other outbound connection meets the matrix's
 * blackhole proxy, which Bun honours through HTTP_PROXY and HTTPS_PROXY.
 *
 * opencode installs @opencode-ai/plugin into each config directory on start
 * and retries for about a minute when the registry is unreachable. A customer
 * machine has it after the first online run; the matrix installs it once per
 * run from npm and seeds each case's directories with it, so no case waits on
 * a registry it cannot reach.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync, copyFileSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { canaries, assertNoCanaries } from '../lib/harness.mjs';
import { deadPort } from '../lib/sink.mjs';
import { installInto } from '../lib/install.mjs';
import { startHangingApi } from './vercel-ai.mjs';

const HOOKS = '@adastracomputing/aer-hooks';

/** The versions under test. The plugin package version tracks the binary. */
export const OPENCODE_PINS = {
  'opencode-ai': '1.18.33',
  '@opencode-ai/plugin': '1.18.33',
};

const USAGE = { input: 101, output: 13 };
const MODEL = 'mx-model';
const PROVIDER_ID = 'mx';

// ---------------------------------------------------------------------------
// The model server. opencode speaks the OpenAI chat completions protocol to a
// custom provider, always streaming. A turn goes: run bash, then read a file,
// then answer. A request without tools is opencode's title generator.

function toolResults(body) {
  return (Array.isArray(body.messages) ? body.messages : []).filter((m) => m?.role === 'tool').length;
}

async function startModelServer(c, k, { command, proj }) {
  const hits = [];
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const text = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    const tools = (Array.isArray(body.tools) ? body.tools : []).map((t) => t?.function?.name).filter(Boolean);
    hits.push({ url: req.url, body: text, tools, toolResults: toolResults(body), stream: body.stream === true });
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    const id = `chatcmpl-${randomUUID()}`;
    const model = body.model ?? MODEL;
    const usage = { prompt_tokens: USAGE.input, completion_tokens: USAGE.output, total_tokens: USAGE.input + USAGE.output };
    const chunk = (delta, finish = null) => ({ id, object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] });
    const send = (d) => res.write(`data: ${typeof d === 'string' ? d : JSON.stringify(d)}\n\n`);

    let call = null;
    let content = 'Matrix run';
    if (tools.length > 0) {
      const done = toolResults(body);
      if (done === 0 && tools.includes('bash')) call = { name: 'bash', args: { command, description: 'print the file' } };
      else if (done === 1 && tools.includes('read')) call = { name: 'read', args: { filePath: join(proj, 'secret.txt') } };
      else content = `Done. ${k.result}`;
    }
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id, object: 'chat.completion', created: 1, model,
        choices: [{ index: 0, message: call ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${hits.length}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { role: 'assistant', content }, finish_reason: call ? 'tool_calls' : 'stop' }],
        usage,
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    send(chunk({ role: 'assistant', content: '' }));
    if (call) send(chunk({ tool_calls: [{ index: 0, id: `call_${hits.length}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }));
    else send(chunk({ content }));
    send(chunk({}, call ? 'tool_calls' : 'stop'));
    send({ id, object: 'chat.completion.chunk', created: 1, model, choices: [], usage });
    send('[DONE]');
    res.end();
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  c.cleanup(() => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }));
  return { hits, url: `http://127.0.0.1:${server.address().port}` };
}

// ---------------------------------------------------------------------------
// The install: opencode itself, and the plugin package opencode wants in its
// config directories. Once per run.

let installed;
function opencodeInstall(env) {
  if (!installed) {
    installed = (async () => {
      const dir = join(env.workRoot, 'opencode');
      const deps = join(env.workRoot, 'opencode-plugin-deps');
      mkdirSync(dir, { recursive: true });
      mkdirSync(deps, { recursive: true });
      const opts = { log: env.log, npmEnv: env.npmEnv, retryMinutes: 1, registry: true };
      await installInto(dir, { 'opencode-ai': { spec: `opencode-ai@${OPENCODE_PINS['opencode-ai']}` } }, opts);
      await installInto(deps, { '@opencode-ai/plugin': { spec: `@opencode-ai/plugin@${OPENCODE_PINS['@opencode-ai/plugin']}` } }, opts);
      const bin = findBinary(dir);
      if (!bin) throw new Error(`opencode-ai@${OPENCODE_PINS['opencode-ai']} installed no runnable binary for ${process.platform}-${process.arch}`);
      if (env.thirdParty) Object.assign(env.thirdParty, OPENCODE_PINS);
      return { bin, deps };
    })().catch((err) => ({ skip: `could not install opencode from npm: ${String(err.message ?? err).split('\n')[0]}` }));
  }
  return installed;
}

/**
 * The binary npm put in place. opencode-ai's postinstall links the platform
 * package's binary over its bin entry; when install scripts are disabled the
 * platform package still carries it.
 */
function findBinary(dir) {
  const nm = join(dir, 'node_modules');
  // opencode-ai names its bin entry opencode.exe on every platform.
  const candidates = [join(nm, 'opencode-ai', 'bin', 'opencode.exe')];
  const plat = process.platform === 'win32' ? 'windows' : process.platform;
  for (const variant of ['', '-baseline', '-musl', '-baseline-musl']) {
    candidates.push(join(nm, `opencode-${plat}-${process.arch}${variant}`, 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode'));
  }
  return candidates.find((p) => existsSync(p) && readFileSync(p).subarray(0, 2).toString('latin1') !== '#!');
}

/** Seed one opencode config directory with the plugin package it expects. */
function seedConfigDir(dir, deps) {
  mkdirSync(dir, { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) copyFileSync(join(deps, f), join(dir, f));
  symlinkSync(join(deps, 'node_modules'), join(dir, 'node_modules'), 'dir');
}

function identity() {
  return {
    AER_API_KEY: `aer_matrix_${randomUUID().replace(/-/g, '')}`,
    AER_TENANT_ID: randomUUID(),
    AER_AGENT_ID: randomUUID(),
    AER_ENV_ID: randomUUID(),
  };
}

/**
 * A project wired the documented way, plus the run. Returns the result, the
 * project directory and the identity used.
 */
async function runOpencode(c, oc, { baseUrl, k, command, prompt, timeoutMs = 120_000, extraEnv = {} }) {
  const home = c.home();
  const proj = c.tmp('oc-proj-');
  const model = await startModelServer(c, k, { command, proj });
  symlinkSync(join(c.install.dir, 'node_modules'), join(proj, 'node_modules'), 'dir');
  writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'mx-opencode', version: '1.0.0', private: true, type: 'module' }));
  writeFileSync(join(proj, 'secret.txt'), `${k.file}\n`);
  mkdirSync(join(proj, '.opencode', 'plugins'), { recursive: true });
  // The README's plugin file, verbatim.
  writeFileSync(join(proj, '.opencode', 'plugins', 'aer.ts'),
    "import { aerOpencodePlugin } from '@adastracomputing/aer-hooks';\nexport const AerPlugin = aerOpencodePlugin;\n");
  writeFileSync(join(proj, 'opencode.json'), JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    provider: {
      [PROVIDER_ID]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Matrix',
        options: { baseURL: `${model.url}/v1`, apiKey: `sk-${k.secret}` },
        models: { [MODEL]: { name: 'Matrix model' } },
      },
    },
    model: `${PROVIDER_ID}/${MODEL}`,
    small_model: `${PROVIDER_ID}/${MODEL}`,
    permission: { bash: 'allow', read: 'allow', edit: 'deny', webfetch: 'deny' },
  }, null, 2));
  seedConfigDir(join(proj, '.opencode'), oc.deps);
  seedConfigDir(join(home, '.config', 'opencode'), oc.deps);

  const id = identity();
  const env = c.env(home, {
    ...id,
    AER_BASE_URL: baseUrl,
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_SHARE: '1',
    ...extraEnv,
  });
  // The shell tool runs `cat` and `echo` from the case PATH; keep Node's own
  // directory and drop nothing else.
  env.PATH = [dirname(process.execPath), ...env.PATH.split(delimiter)].join(delimiter);
  const r = await c.run(oc.bin, ['run', '--print-logs', '--log-level', 'WARN', prompt], { cwd: proj, env, timeoutMs });
  return { r, proj, id, model };
}

const opens = (sink) => sink.find('POST', '/v1/sessions');
const completes = (sink) => sink.find('POST', /^\/v1\/sessions\/[^/]+\/complete$/);
const byType = (sink, t) => sink.events().filter((e) => e.event_type === t);

// ---------------------------------------------------------------------------

export default function register(registry, env) {
  const t = registry.suite('opencode', `${HOOKS} in opencode-ai@${OPENCODE_PINS['opencode-ai']}`);

  const occase = (title, fn) => t.case(title, async (c) => {
    const oc = await opencodeInstall(env);
    if (oc.skip) return oc;
    c.note(Object.entries(OPENCODE_PINS).map(([n, v]) => `${n}@${v}`).join(', '));
    return fn(c, oc);
  }, { timeoutMs: 600_000 });

  occase('opencode run: the documented plugin records one session with tools, programs, file, model and tokens, bodies-off', async (c, oc) => {
    const sink = await c.sink();
    const k = canaries('OCRUN');
    const command = `cat secret.txt && echo ${k.args}`;
    const { r, proj, id, model } = await runOpencode(c, oc, { baseUrl: sink.url, k, command, prompt: `Show me secret.txt. ${k.prompt}` });
    c.assert.ok(!r.timedOut, 'opencode run hung');
    c.assert.exit(r, 0, 'opencode run');
    c.assert.excludes(r.stderr, 'failed to load plugin', 'opencode could not load the AER plugin');
    c.assert.includes(r.stdout, k.result, 'the model answer on stdout');
    // opencode really ran the tools: the second request carries bash's output.
    const withTools = model.hits.filter((h) => h.tools.length > 0);
    c.assert.ok(withTools.length >= 3, `model requests with tools: ${withTools.length}`);
    c.assert.includes(withTools[1].body, k.file, 'bash output fed back to the model');

    c.assert.equal(opens(sink).length, 1, 'sessions opened');
    const open = opens(sink)[0].json;
    c.assert.equal(open.tenant_id, id.AER_TENANT_ID, 'tenant_id');
    c.assert.equal(open.agent_id, id.AER_AGENT_ID, 'agent_id');
    c.assert.equal(open.environment_id, id.AER_ENV_ID, 'environment_id');
    c.assert.equal(opens(sink)[0].headers.authorization, `Bearer ${id.AER_API_KEY}`, 'tenant key');
    c.assert.equal(open.collector?.name, 'aer-hooks', `collector at session open: ${JSON.stringify(open.collector)}`);
    c.assert.equal(open.collector?.version, c.install.version(HOOKS), 'collector version');
    const ev = sink.events();
    c.assert.ok(ev.every((e) => e.source_type === 'harness'), `source_type: ${[...new Set(ev.map((e) => e.source_type))].join(', ')}`);
    const unmarked = ev.filter((e) => e.payload?.harness !== 'opencode');
    c.assert.equal(unmarked.length, 0, `events without harness opencode: ${[...new Set(unmarked.map((e) => e.event_type))].join(', ')}`);
    const phases = byType(sink, 'collector.report').map((e) => e.payload?.phase);
    c.assert.equal(JSON.stringify(phases), JSON.stringify(['session_start', 'session_end']), 'session markers, the end one written on dispose');

    const started = byType(sink, 'tool.started');
    c.assert.equal(started.map((e) => e.payload.tool).join(','), 'bash,read', 'tool.started');
    c.assert.equal(JSON.stringify(started[0].payload.arg_keys), JSON.stringify(['command', 'description']), 'bash argument key names');
    c.assert.equal(byType(sink, 'tool.completed').map((e) => `${e.payload.tool}:${e.payload.ok}`).join(','), 'bash:true,read:true', 'tool.completed');
    const execs = byType(sink, 'process.exec').map((e) => e.payload.command);
    c.assert.equal(execs.join(','), 'cat,echo', `process.exec programs: ${JSON.stringify(byType(sink, 'process.exec').map((e) => e.payload))}`);
    const opened = byType(sink, 'file.opened');
    c.assert.equal(opened.length, 1, `file.opened: ${JSON.stringify(opened.map((e) => e.payload))}`);
    c.assert.equal(opened[0].payload.path, join(proj, 'secret.txt'), 'file.opened path');

    const done = byType(sink, 'llm.completed');
    c.assert.equal(done.length, 3, `llm.completed, one per assistant step: ${JSON.stringify(done.map((e) => e.payload))}`);
    for (const e of done) {
      c.assert.equal(e.payload.model, MODEL, 'model');
      c.assert.equal(e.payload.provider, PROVIDER_ID, 'provider');
      c.assert.equal(e.payload.input_tokens, USAGE.input, 'input_tokens');
      c.assert.equal(e.payload.output_tokens, USAGE.output, 'output_tokens');
    }
    c.assert.equal(byType(sink, 'llm.requested').length, 3, 'llm.requested');

    c.assert.equal(completes(sink).length, 1, 'sessions completed on dispose');
    c.assert.equal([...sink.sessions.values()][0].status, 'completed', 'session status at the sink');
    assertNoCanaries(sink.allText(), k);
    c.note(`${ev.length} events; opencode exited after ${r.ms} ms`);
  });

  occase('opencode run with the AER API down: opencode still answers and exits on time, and cannot reach the internet', async (c, oc) => {
    const k = canaries('OCDOWN');
    const port = await deadPort();
    // The models catalogue fetch stays on here, as the proof that the
    // blackhole proxy holds for a Bun binary too: it must fail to connect.
    const { r } = await runOpencode(c, oc, { baseUrl: `http://127.0.0.1:${port}`, k, command: 'cat secret.txt', prompt: `Show me secret.txt. ${k.prompt}`, timeoutMs: 90_000, extraEnv: { OPENCODE_DISABLE_MODELS_FETCH: undefined } });
    c.assert.match(r.stderr, /Failed to fetch models\.dev[^\n]*(Unable to connect|ECONNREFUSED)/, 'opencode reached the models catalogue through the blackhole proxy');
    c.assert.ok(!r.timedOut, 'opencode run hung with the AER API unreachable');
    c.assert.exit(r, 0, 'opencode run');
    c.assert.includes(r.stdout, k.result, 'the model answer on stdout');
    c.assert.excludes(r.stderr, 'failed to load plugin', 'opencode could not load the AER plugin');
    c.assert.ok(r.ms < 60_000, `opencode took ${r.ms} ms`);
    c.note(`exit after ${r.ms} ms`);
  });

  occase('opencode run with an AER API that never answers: opencode exits within the plugin bound', async (c, oc) => {
    const k = canaries('OCHANG');
    const api = await startHangingApi(c);
    const { r } = await runOpencode(c, oc, { baseUrl: api.url, k, command: 'cat secret.txt', prompt: `Show me secret.txt. ${k.prompt}`, timeoutMs: 90_000 });
    c.assert.ok(!r.timedOut, 'opencode run hung with the AER API not answering');
    c.assert.exit(r, 0, 'opencode run');
    c.assert.includes(r.stdout, k.result, 'the model answer on stdout');
    c.assert.ok(api.accepted() > 0, 'the plugin never reached the hanging API');
    // The same run against a live sink takes about 15 s; dispose adds at most 3 s.
    c.assert.ok(r.ms < 45_000, `opencode took ${r.ms} ms`);
    c.note(`exit after ${r.ms} ms`);
  });

  occase('opencode run without AER_ENV_ID: the plugin is a no-op and opencode is unaffected', async (c, oc) => {
    const sink = await c.sink();
    const k = canaries('OCNOENV');
    const { r } = await runOpencode(c, oc, { baseUrl: sink.url, k, command: 'cat secret.txt', prompt: `Show me secret.txt. ${k.prompt}`, extraEnv: { AER_ENV_ID: undefined } });
    c.assert.exit(r, 0, 'opencode run');
    c.assert.includes(r.stdout, k.result, 'the model answer on stdout');
    c.assert.equal(sink.requests.length, 0, 'requests reached the sink');
  });
}
