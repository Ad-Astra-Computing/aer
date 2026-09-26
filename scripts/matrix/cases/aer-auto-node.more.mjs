/**
 * aer-auto-node, the parts the first matrix did not reach: the LLM SDK
 * adapters against a local provider, the task and server session strategies,
 * attestation through node:http(s), synchronous subprocesses, the key name
 * fallback and the agent tool shell guard.
 *
 * The LLM cases install the real provider SDKs (latest from npm) next to the
 * candidate collector in their own project, once per run, and point them at a
 * local server that answers the way the real APIs do. Nothing reaches a real
 * provider.
 */
import { createServer } from 'node:http';
import { verify as cryptoVerify, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canaries, assertNoCanaries } from '../lib/harness.mjs';
import { installInto } from '../lib/install.mjs';
import {
  startTarget, IDS, runWorkload, fetchOnce, byType, decodeJwt, assertCompletedOnce, protectedConfig,
} from './aer-auto-node.mjs';

const PKG = '@adastracomputing/aer-auto-node';
const SDKS = ['openai', '@anthropic-ai/sdk', 'ai', '@ai-sdk/openai'];

// ---------------------------------------------------------------------------
// A local provider shaped like the OpenAI chat completions API and the
// Anthropic messages API, streaming and not. Every response carries the
// result canary, a tool call whose arguments carry the args canary, and fixed
// token counts, so a case can check that the metadata arrived and the content
// did not.

const USAGE = { input: 11, output: 7 };

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const e of events) res.write(e);
  res.end();
}

async function startProvider(c, k) {
  const hits = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const text = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    hits.push({ method: req.method, url: req.url, body: text });
    const model = body.model ?? 'mx-model';
    const args = JSON.stringify({ q: k.args });
    if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
      const id = `chatcmpl-${randomUUID()}`;
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id, object: 'chat.completion', created: 1, model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: k.result, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: args } }] },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: USAGE.input, completion_tokens: USAGE.output, total_tokens: USAGE.input + USAGE.output },
        }));
        return;
      }
      const chunk = (delta, extra = {}) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: null, ...extra }] })}\n\n`;
      sse(res, [
        chunk({ role: 'assistant', content: '' }),
        chunk({ content: k.result }),
        chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: args } }] }),
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model, choices: [], usage: { prompt_tokens: USAGE.input, completion_tokens: USAGE.output, total_tokens: USAGE.input + USAGE.output } })}\n\n`,
        'data: [DONE]\n\n',
      ]);
      return;
    }
    if (req.method === 'POST' && req.url.endsWith('/v1/messages')) {
      const id = `msg_${randomUUID().replace(/-/g, '')}`;
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id, type: 'message', role: 'assistant', model,
          content: [{ type: 'text', text: k.result }, { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: k.args } }],
          stop_reason: 'tool_use', stop_sequence: null,
          usage: { input_tokens: USAGE.input, output_tokens: USAGE.output },
        }));
        return;
      }
      const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      sse(res, [
        ev('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: USAGE.input, output_tokens: 1 } } }),
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: k.result } }),
        ev('content_block_stop', { index: 0 }),
        ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} } }),
        ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: args } }),
        ev('content_block_stop', { index: 1 }),
        ev('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: USAGE.output } }),
        ev('message_stop', {}),
      ]);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  c.cleanup(() => new Promise((r) => server.close(() => r())));
  return { hits, url: `http://127.0.0.1:${server.address().port}` };
}

/**
 * The provider SDKs plus the candidate collector, installed once per run the
 * way a customer project would have them. Returns the node_modules path, or
 * a { skip } when npm cannot reach the registry.
 */
let sdkInstall;
function sdkProject(env) {
  if (!sdkInstall) {
    sdkInstall = (async () => {
      const dir = join(env.workRoot, 'llm-sdks');
      mkdirSync(dir, { recursive: true });
      const specs = {
        [PKG]: { spec: env.install.spec(PKG) },
        ...Object.fromEntries(SDKS.map((n) => [n, { spec: n }])),
      };
      // A local tarball of the collector depends on nothing else from the
      // workspace, so it installs alone next to the SDKs.
      await installInto(dir, specs, { log: env.log, npmEnv: env.npmEnv, retryMinutes: 1, registry: env.opts.source === 'registry' });
      const nm = join(dir, 'node_modules');
      for (const n of SDKS) if (!existsSync(join(nm, n, 'package.json'))) throw new Error(`${n} did not install`);
      return nm;
    })().catch((err) => ({ skip: `could not install the provider SDKs from npm: ${String(err.message ?? err).split('\n')[0]}` }));
  }
  return sdkInstall;
}

const sdkVersion = (nm, n) => {
  try { return JSON.parse(readFileSync(join(nm, n, 'package.json'), 'utf8')).version; } catch { return '?'; }
};

function assertLlm(c, sink, provider, { streaming, calls }) {
  const ev = sink.events();
  const req = byType(ev, 'llm.requested').filter((e) => e.payload.provider === provider);
  const done = byType(ev, 'llm.completed').filter((e) => e.payload.provider === provider);
  c.assert.equal(req.length, calls, `${provider} llm.requested events`);
  c.assert.equal(done.length, calls, `${provider} llm.completed events`);
  for (const e of req) c.assert.equal(e.payload.model, 'mx-model', `${provider} llm.requested model`);
  for (const e of done) {
    c.assert.equal(e.payload.ok, true, `${provider} llm.completed ok`);
    if (streaming !== undefined) c.assert.equal(Boolean(e.payload.streaming), streaming, `${provider} streaming flag`);
    c.assert.equal(e.payload.input_tokens, USAGE.input, `${provider} input_tokens`);
    c.assert.equal(e.payload.output_tokens, USAGE.output, `${provider} output_tokens`);
  }
  const tools = byType(ev, 'tool.selected').filter((e) => e.payload.provider === provider);
  c.assert.equal(tools.length, calls, `${provider} tool.selected events`);
  for (const e of tools) c.assert.equal(e.payload.tool, 'lookup', `${provider} tool name`);
}

// ---------------------------------------------------------------------------

export default function register(registry, env) {
  const t = registry.suite('aer-auto-node', PKG);

  // ---- LLM adapters ---------------------------------------------------------

  const llmCase = (title, fn) => t.case(title, async (c) => {
    const nm = await sdkProject(env);
    if (nm.skip) return nm;
    return fn(c, nm);
  }, { timeoutMs: 600_000 });

  llmCase('llm: openai chat completions, plain and streaming, bodies-off', async (c, nm) => {
    const sink = await c.sink();
    const k = canaries('LLMOAI');
    const provider = await startProvider(c, k);
    const r = await runWorkload(c, {
      nodeModules: nm,
      config: { ...IDS(), base_url: sink.url },
      env: { MX: JSON.stringify(k), PROVIDER: `${provider.url}/v1` },
      workload: `
        import OpenAI from 'openai';
        const k = JSON.parse(process.env.MX);
        const client = new OpenAI({ apiKey: 'sk-' + k.secret, baseURL: process.env.PROVIDER });
        const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }];
        const messages = [{ role: 'system', content: k.prompt }, { role: 'user', content: k.prompt }, { role: 'tool', tool_call_id: 'call_0', content: k.result }];
        const plain = await client.chat.completions.create({ model: 'mx-model', messages, tools });
        const stream = await client.chat.completions.create({ model: 'mx-model', messages, tools, stream: true, stream_options: { include_usage: true } });
        let streamed = '';
        for await (const ch of stream) streamed += ch.choices[0]?.delta?.content ?? '';
        console.log(JSON.stringify({ ok: plain.choices[0].message.content === k.result && streamed === k.result }));
      `,
    });
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(r.json?.ok, true, 'the SDK returned the provider content unchanged');
    c.assert.includes(provider.hits[0]?.body, k.prompt, 'prompt at the provider');
    assertLlm(c, sink, 'openai', { calls: 2 });
    const done = byType(sink.events(), 'llm.completed').filter((e) => e.payload.provider === 'openai');
    c.assert.ok(done.some((e) => e.payload.streaming === true), 'no streaming llm.completed');
    assertNoCanaries(sink.allText(), k);
    const report = byType(sink.events(), 'collector.report').pop();
    c.assert.equal(report?.payload?.adapter_activity?.openai?.calls, 2, 'adapter_activity.openai.calls');
    c.note(`openai ${sdkVersion(nm, 'openai')}`);
  });

  llmCase('llm: anthropic messages, plain and streaming, bodies-off', async (c, nm) => {
    const sink = await c.sink();
    const k = canaries('LLMANT');
    const provider = await startProvider(c, k);
    const r = await runWorkload(c, {
      nodeModules: nm,
      config: { ...IDS(), base_url: sink.url },
      env: { MX: JSON.stringify(k), PROVIDER: provider.url },
      workload: `
        import Anthropic from '@anthropic-ai/sdk';
        const k = JSON.parse(process.env.MX);
        const client = new Anthropic({ apiKey: 'sk-ant-' + k.secret, baseURL: process.env.PROVIDER });
        const tools = [{ name: 'lookup', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }];
        const messages = [{ role: 'user', content: k.prompt }];
        const plain = await client.messages.create({ model: 'mx-model', max_tokens: 64, system: k.prompt, messages, tools });
        const stream = await client.messages.create({ model: 'mx-model', max_tokens: 64, messages, tools, stream: true });
        let streamed = '';
        for await (const ev of stream) if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') streamed += ev.delta.text;
        console.log(JSON.stringify({ ok: plain.content[0].text === k.result && streamed === k.result }));
      `,
    });
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(r.json?.ok, true, 'the SDK returned the provider content unchanged');
    c.assert.includes(provider.hits[0]?.body, k.prompt, 'prompt at the provider');
    assertLlm(c, sink, 'anthropic', { calls: 2 });
    assertNoCanaries(sink.allText(), k);
    c.note(`@anthropic-ai/sdk ${sdkVersion(nm, '@anthropic-ai/sdk')}`);
  });

  llmCase('llm: vercel ai generateText and streamText through an openai provider, bodies-off', async (c, nm) => {
    const sink = await c.sink();
    const k = canaries('LLMVAI');
    const provider = await startProvider(c, k);
    const r = await runWorkload(c, {
      nodeModules: nm,
      config: { ...IDS(), base_url: sink.url },
      env: { MX: JSON.stringify(k), PROVIDER: `${provider.url}/v1` },
      workload: `
        import { generateText, streamText } from 'ai';
        import { createOpenAI } from '@ai-sdk/openai';
        const k = JSON.parse(process.env.MX);
        const openai = createOpenAI({ apiKey: 'sk-' + k.secret, baseURL: process.env.PROVIDER });
        const model = openai.chat('mx-model');
        const a = await generateText({ model, system: k.prompt, prompt: k.prompt });
        const s = streamText({ model, prompt: k.prompt });
        let streamed = '';
        for await (const part of s.textStream) streamed += part;
        await s.usage;
        console.log(JSON.stringify({ ok: a.text === k.result && streamed === k.result }));
      `,
    });
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(r.json?.ok, true, 'the SDK returned the provider content unchanged');
    const ev = sink.events();
    const req = byType(ev, 'llm.requested');
    const done = byType(ev, 'llm.completed');
    c.assert.ok(req.length >= 2, `llm.requested events: ${req.length}`);
    c.assert.ok(done.length >= 2, `llm.completed events: ${done.length}`);
    c.assert.ok(done.some((e) => e.payload.input_tokens === USAGE.input && e.payload.output_tokens === USAGE.output), `token counts: ${JSON.stringify(done.map((e) => e.payload))}`);
    assertNoCanaries(sink.allText(), k);
    c.note(`ai ${sdkVersion(nm, 'ai')}, @ai-sdk/openai ${sdkVersion(nm, '@ai-sdk/openai')}; providers ${[...new Set(req.map((e) => e.payload.provider))].join(', ')}`);
  });

  // ---- session strategies ---------------------------------------------------

  const withSessionWorkload = (urls, outside) => `
    import { withAerSession } from '${PKG}';
    const hit = async (u) => { const r = await fetch(u); await r.text(); };
    ${outside ? `await hit(${JSON.stringify(outside)});` : ''}
    ${urls.map((u, i) => `await withAerSession({}, async () => { await hit(${JSON.stringify(u)}); });`).join('\n')}
    console.log(JSON.stringify({ ok: true }));
  `;

  const sessionsWith = (sink) => [...sink.sessions.values()].map((s) => ({
    status: s.status,
    events: s.events.filter((e) => e.event_type === 'http.requested').length,
  }));

  t.case('strategy task: one session per withAerSession, activity outside falls back to a process session', async (c) => {
    const sink = await c.sink();
    const target = await startTarget(c);
    const r = await runWorkload(c, {
      config: { ...IDS(), base_url: sink.url, session: { strategy: 'task' } },
      workload: withSessionWorkload([`${target.url}/t1`, `${target.url}/t2`], `${target.url}/outside`),
    });
    c.assert.exit(r, 0, 'workload');
    const sessions = sessionsWith(sink);
    c.assert.equal(sessions.length, 3, `sessions: ${JSON.stringify(sessions)}`);
    c.assert.ok(sessions.every((s) => s.status === 'completed'), `every session completes: ${JSON.stringify(sessions)}`);
    c.assert.ok(sessions.every((s) => s.events === 1), `one request per session: ${JSON.stringify(sessions)}`);
  });

  t.case('strategy task with requireTask: activity outside a task is not recorded', async (c) => {
    const sink = await c.sink();
    const target = await startTarget(c);
    const r = await runWorkload(c, {
      config: { ...IDS(), base_url: sink.url, session: { strategy: 'task', requireTask: true } },
      workload: withSessionWorkload([`${target.url}/t1`], `${target.url}/outside`),
    });
    c.assert.exit(r, 0, 'workload');
    const sessions = sessionsWith(sink);
    c.assert.equal(sessions.length, 1, `sessions: ${JSON.stringify(sessions)}`);
    c.assert.equal(sessions[0].status, 'completed', 'task session status');
    c.assert.equal(target.hits.length, 2, 'both requests still reached the target');
  });

  t.case('strategy server: nothing implicit; each withAerSession is its own session with its own identity', async (c) => {
    const sink = await c.sink();
    const target = await startTarget(c);
    const agent = randomUUID();
    const r = await runWorkload(c, {
      config: { ...IDS(), base_url: sink.url, session: { strategy: 'server' } },
      workload: `
        import { withAerSession } from '${PKG}';
        const hit = async (u) => { const r = await fetch(u); await r.text(); };
        await hit(${JSON.stringify(`${target.url}/outside`)});
        await Promise.all([
          withAerSession({ agentId: ${JSON.stringify(agent)} }, () => hit(${JSON.stringify(`${target.url}/a`)})),
          withAerSession({}, () => hit(${JSON.stringify(`${target.url}/b`)})),
        ]);
        await hit(${JSON.stringify(`${target.url}/outside-again`)});
        console.log(JSON.stringify({ ok: true }));
      `,
    });
    c.assert.exit(r, 0, 'workload');
    const opens = sink.find('POST', '/v1/sessions');
    c.assert.equal(opens.length, 2, 'sessions opened');
    c.assert.ok(opens.some((o) => o.json.agent_id === agent), 'the per-task agentId was not used');
    const sessions = sessionsWith(sink);
    c.assert.ok(sessions.every((s) => s.status === 'completed' && s.events === 1), `each task session holds its own request: ${JSON.stringify(sessions)}`);
    c.assert.equal(target.hits.length, 4, 'all requests reached the target');
  });

  // ---- attestation through node:https ----------------------------------------

  const httpsTwice = (url, extra = '') => `
    import https from 'node:https';
    const get = () => new Promise((res) => {
      const req = https.request(${JSON.stringify(url)}, { method: 'GET' }, (r) => { r.resume(); r.on('end', () => res({ status: r.statusCode })); });
      req.on('error', (e) => res({ error: e.code ?? String(e) }));
      req.end();
    });
    const first = await get();
    await new Promise((r) => setTimeout(r, 300));
    const second = await get();
    ${extra}
    console.log(JSON.stringify({ first, second }));
  `;

  t.case('attestation via node:https: a cached token is attached, signed by the sink key', async (c) => {
    const sink = await c.sink();
    const prot = await startTarget(c, { tls: true });
    const r = await runWorkload(c, {
      config: protectedConfig(sink, prot, {}),
      env: { NODE_EXTRA_CA_CERTS: prot.certFile },
      workload: httpsTwice(`${prot.url}/tools`),
    });
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(r.json?.second?.status, 200, 'second request');
    // The sync API cannot wait for a mint: the process strategy prewarms at
    // startup, so the second request at the latest carries the token.
    const tok = prot.hits[1]?.headers['x-aer-attestation'];
    c.assert.ok(tok, `no X-AER-Attestation on the second node:https request (first had ${prot.hits[0]?.headers['x-aer-attestation'] ? 'one' : 'none'})`);
    const j = decodeJwt(tok);
    c.assert.ok(cryptoVerify(null, Buffer.from(j.input), sink.attestationKey.publicKey, j.sig), 'token signature does not verify with the sink key');
    c.assert.equal(j.payload.aud, 'mcp://matrix-protected', 'token audience');
    const reqs = byType(sink.events(), 'http.requested');
    c.assert.ok(reqs.every((e) => !String(JSON.stringify(e.payload)).includes('/tools')), 'a request path reached the sink');
    assertCompletedOnce(c, sink);
  });

  t.case('attestation via node:https: block + fail_closed with the mint failing denies before the socket opens', async (c) => {
    const sink = await c.sink();
    sink.fault({ method: 'POST', path: /\/attestations$/, status: 503 });
    const prot = await startTarget(c, { tls: true });
    const r = await runWorkload(c, {
      config: protectedConfig(sink, prot, { enforcement: 'block', on_unavailable: 'fail_closed' }),
      env: { NODE_EXTRA_CA_CERTS: prot.certFile },
      workload: httpsTwice(`${prot.url}/tools`),
    });
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(r.json?.first?.error, 'E_AER_EGRESS_BLOCKED', 'first request error');
    c.assert.equal(r.json?.second?.error, 'E_AER_EGRESS_BLOCKED', 'second request error');
    c.assert.equal(prot.hits.length, 0, 'the protected target saw a request');
    c.assert.ok(byType(sink.events(), 'egress.blocked').length >= 2, 'egress.blocked events');
  });

  // ---- subprocesses, key names, agent shells ---------------------------------

  t.case('synchronous subprocesses: spawnSync, execSync and execFileSync are recorded, bodies-off', async (c) => {
    const sink = await c.sink();
    const target = await startTarget(c);
    const k = canaries('SYNC');
    const r = await runWorkload(c, {
      config: { ...IDS(), base_url: sink.url },
      env: { MX: JSON.stringify(k) },
      workload: `
        import cp from 'node:child_process';
        const k = JSON.parse(process.env.MX);
        const a = cp.spawnSync(process.execPath, ['-e', 'process.exit(3)', k.args]);
        const b = cp.execSync('SECRET=' + k.secret + ' node -e "process.stdout.write(\\'' + k.result + '\\')"').toString();
        const d = cp.execFileSync(process.execPath, ['-e', '0', k.args]).toString();
        let failed = null;
        try { cp.execSync('node -e "process.exit(2)"', { stdio: 'ignore' }); } catch (e) { failed = e.status; }
        const f = await fetch(${JSON.stringify(`${target.url}/`)}); await f.text();
        console.log(JSON.stringify({ ok: a.status === 3 && b === k.result && d === '' && failed === 2 }));
      `,
    });
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(r.json?.ok, true, 'the workload saw unchanged results');
    const ev = sink.events();
    const execs = byType(ev, 'process.exec');
    c.assert.equal(execs.length, 4, `process.exec events: ${JSON.stringify(execs.map((e) => e.payload))}`);
    for (const e of execs) c.assert.equal(e.payload.command, 'node', 'command');
    const codes = byType(ev, 'process.exit').map((e) => e.payload.exit_code).sort();
    c.assert.equal(JSON.stringify(codes), JSON.stringify([0, 0, 2, 3]), 'exit codes');
    assertNoCanaries(sink.allText(), k);
  });

  t.case('AER_TENANT_API_KEY alone is enough for the collector, as it is for aer doctor', async (c) => {
    const sink = await c.sink();
    const target = await startTarget(c);
    const r = await runWorkload(c, {
      config: { ...IDS(), base_url: sink.url },
      env: { AER_API_KEY: undefined, AER_TENANT_API_KEY: 'aer_tenant_only_key' },
      workload: fetchOnce(`${target.url}/`),
    });
    c.assert.exit(r, 0, 'workload');
    const open = sink.find('POST', '/v1/sessions')[0];
    c.assert.ok(open, 'no session was opened with only AER_TENANT_API_KEY set');
    c.assert.equal(open.headers.authorization, 'Bearer aer_tenant_only_key', 'key sent');
  });

  for (const [label, marker] of [['CLAUDECODE=1', { CLAUDECODE: '1' }], ['CLAUDE_CODE_ENTRYPOINT', { CLAUDE_CODE_ENTRYPOINT: 'cli' }]]) {
    t.case(`agent tool shell (${label}): nothing recorded, one stderr line says why`, async (c) => {
      const sink = await c.sink();
      const target = await startTarget(c);
      const r = await runWorkload(c, {
        config: { ...IDS(), base_url: sink.url },
        env: marker,
        workload: fetchOnce(`${target.url}/`),
      });
      c.assert.exit(r, 0, 'workload');
      c.assert.equal(r.json?.status, 200, 'the host still ran');
      c.assert.equal(sink.requests.length, 0, 'requests reached the sink');
      const lines = r.stderr.split('\n').filter((l) => l.includes('AER_RECORD_IN_AGENT_SHELL'));
      c.assert.equal(lines.length, 1, `stderr: ${r.stderr.trim()}`);
      c.assert.excludes(r.stderr, 'aer_matrix_test_key', 'the key was printed');
    });
  }

  t.case('agent tool shell: AER_RECORD_IN_AGENT_SHELL=1 records on purpose', async (c) => {
    const sink = await c.sink();
    const target = await startTarget(c);
    const r = await runWorkload(c, {
      config: { ...IDS(), base_url: sink.url },
      env: { CLAUDECODE: '1', AER_RECORD_IN_AGENT_SHELL: '1' },
      workload: fetchOnce(`${target.url}/`),
    });
    c.assert.exit(r, 0, 'workload');
    assertCompletedOnce(c, sink);
  });
}
