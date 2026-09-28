/**
 * The Vercel AI SDK, end to end: the real `ai` package and the real provider
 * packages the collector instruments, installed at pinned versions next to the
 * candidate collector, loaded through the register hook exactly as `aer init`
 * wires it, and pointed at a local server that speaks each provider's own wire
 * format, streaming SSE included.
 *
 * The provider plants canaries in everything that is content: the prompt the
 * workload sends, the text the model returns, the tool arguments the model
 * picks and the tool result the workload computes. None may reach the sink.
 *
 * With --live and a provider key supplied in MATRIX_OPENAI_API_KEY or
 * MATRIX_ANTHROPIC_API_KEY, one more case repeats the basic path against the
 * real provider. The key is read from the runner's environment only, never
 * from disk, and the capture sink stays local.
 */
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canaries, assertNoCanaries } from '../lib/harness.mjs';
import { installInto } from '../lib/install.mjs';
import { IDS, runWorkload, byType, assertCompletedOnce } from './aer-auto-node.mjs';

const PKG = '@adastracomputing/aer-auto-node';

/**
 * The versions under test. Pinned so a run is reproducible and a new SDK
 * release shows up as a deliberate change to this table, not as a surprise.
 * @ai-sdk/openai-compatible is here as a provider the collector does NOT
 * instrument, for the model-unknown case.
 */
export const VERCEL_PINS = {
  ai: '7.0.118',
  '@ai-sdk/openai': '4.0.78',
  '@ai-sdk/anthropic': '4.0.65',
  '@ai-sdk/openai-compatible': '3.0.57',
  '@ai-sdk/google': '4.0.82',
  '@ai-sdk/mistral': '4.0.52',
  '@ai-sdk/groq': '4.0.50',
  zod: '4.6.5',
};

const USAGE = { input: 11, output: 7 };
const TOOL = 'lookup';

// ---------------------------------------------------------------------------
// The local provider. Each API answers the way the real one does: a tool call
// when tools are offered and no tool result has come back yet, structured
// JSON when a schema is requested, text otherwise. A request whose body holds
// MX_SLOW gets one text delta and then a stream that never finishes, so a
// case can abort it midway.

const sseWrite = (res, data, event) => res.write(`${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);

function hasToolResult(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  if (msgs.some((m) => m?.role === 'tool')) return true;
  if (msgs.some((m) => Array.isArray(m?.content) && m.content.some((p) => p?.type === 'tool_result'))) return true;
  const input = Array.isArray(body.input) ? body.input : [];
  return input.some((i) => i?.type === 'function_call_output');
}

export async function startVercelProvider(c, k) {
  const hits = [];
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const text = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    const hit = { method: req.method, url: req.url, body: text, model: body.model, stream: body.stream === true };
    hits.push(hit);
    const model = body.model ?? 'mx-model';
    const slow = text.includes('MX_SLOW');
    const wantsTool = Array.isArray(body.tools) && body.tools.length > 0 && !hasToolResult(body);
    const args = JSON.stringify({ q: k.args });
    const answer = (body.response_format?.type === 'json_schema' || body.text?.format?.type === 'json_schema')
      ? JSON.stringify({ answer: k.result })
      : k.result;
    const hold = () => {
      // A slow stream: one delta, then silence until the client goes away.
      const t = setTimeout(() => res.end(), 30_000);
      req.on('close', () => { hit.closedEarly = !res.writableEnded; clearTimeout(t); });
      res.on('close', () => { hit.closedEarly = !res.writableEnded; clearTimeout(t); });
    };

    if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
      const id = `chatcmpl-${randomUUID()}`;
      const usage = { prompt_tokens: USAGE.input, completion_tokens: USAGE.output, total_tokens: USAGE.input + USAGE.output };
      const toolCall = { id: 'call_1', type: 'function', function: { name: TOOL, arguments: args } };
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id, object: 'chat.completion', created: 1, model,
          choices: [{
            index: 0,
            message: wantsTool ? { role: 'assistant', content: null, tool_calls: [toolCall] } : { role: 'assistant', content: answer },
            finish_reason: wantsTool ? 'tool_calls' : 'stop',
          }],
          usage,
        }));
        return;
      }
      const chunk = (delta, finish = null) => ({ id, object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      sseWrite(res, chunk({ role: 'assistant', content: '' }));
      if (slow) { sseWrite(res, chunk({ content: k.result })); hold(); return; }
      if (wantsTool) sseWrite(res, chunk({ tool_calls: [{ index: 0, ...toolCall }] }));
      else sseWrite(res, chunk({ content: answer }));
      if (body.stream_options?.include_usage) {
        // OpenAI: usage arrives in a trailing chunk with no choices.
        sseWrite(res, chunk({}, wantsTool ? 'tool_calls' : 'stop'));
        sseWrite(res, { id, object: 'chat.completion.chunk', created: 1, model, choices: [], usage });
      } else {
        // Mistral and Groq: usage rides on the finishing chunk.
        sseWrite(res, { ...chunk({}, wantsTool ? 'tool_calls' : 'stop'), usage, x_groq: { usage } });
      }
      sseWrite(res, '[DONE]');
      res.end();
      return;
    }

    if (req.method === 'POST' && req.url.endsWith('/responses')) {
      const id = `resp_${randomUUID().replace(/-/g, '')}`;
      const usage = { input_tokens: USAGE.input, input_tokens_details: { cached_tokens: 0 }, output_tokens: USAGE.output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: USAGE.input + USAGE.output };
      const msgItem = { type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: answer, annotations: [], logprobs: [] }] };
      const fnItem = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: TOOL, arguments: args, status: 'completed' };
      const base = { id, object: 'response', created_at: 1, model, error: null, incomplete_details: null, tools: [], parallel_tool_calls: true };
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...base, status: 'completed', output: [wantsTool ? fnItem : msgItem], usage }));
        return;
      }
      let seq = 0;
      const ev = (type, data) => sseWrite(res, { type, sequence_number: seq++, ...data }, type);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      ev('response.created', { response: { ...base, status: 'in_progress', output: [], usage: null } });
      ev('response.in_progress', { response: { ...base, status: 'in_progress', output: [], usage: null } });
      if (wantsTool) {
        ev('response.output_item.added', { output_index: 0, item: { ...fnItem, arguments: '', status: 'in_progress' } });
        ev('response.function_call_arguments.delta', { item_id: 'fc_1', output_index: 0, delta: args });
        ev('response.function_call_arguments.done', { item_id: 'fc_1', output_index: 0, arguments: args });
        ev('response.output_item.done', { output_index: 0, item: fnItem });
      } else {
        ev('response.output_item.added', { output_index: 0, item: { ...msgItem, status: 'in_progress', content: [] } });
        ev('response.content_part.added', { item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        ev('response.output_text.delta', { item_id: 'msg_1', output_index: 0, content_index: 0, delta: slow ? k.result : answer, logprobs: [] });
        if (slow) { hold(); return; }
        ev('response.output_text.done', { item_id: 'msg_1', output_index: 0, content_index: 0, text: answer, logprobs: [] });
        ev('response.content_part.done', { item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: answer, annotations: [] } });
        ev('response.output_item.done', { output_index: 0, item: msgItem });
      }
      ev('response.completed', { response: { ...base, status: 'completed', output: [wantsTool ? fnItem : msgItem], usage } });
      res.end();
      return;
    }

    const gm = req.method === 'POST' ? req.url.match(/\/models\/([^/:?]+):(generateContent|streamGenerateContent)/) : null;
    if (gm) {
      // Google's Generative Language API.
      const usageMetadata = { promptTokenCount: USAGE.input, candidatesTokenCount: USAGE.output, totalTokenCount: USAGE.input + USAGE.output };
      const candidate = (text, finish) => ({ content: { role: 'model', parts: [{ text }] }, index: 0, ...(finish ? { finishReason: 'STOP' } : {}) });
      if (gm[2] === 'generateContent') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ candidates: [candidate(answer, true)], usageMetadata, modelVersion: gm[1] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      sseWrite(res, { candidates: [candidate(answer, false)], modelVersion: gm[1] });
      sseWrite(res, { candidates: [candidate('', true)], usageMetadata, modelVersion: gm[1] });
      res.end();
      return;
    }

    if (req.method === 'POST' && req.url.endsWith('/v1/messages')) {
      const id = `msg_${randomUUID().replace(/-/g, '')}`;
      const content = wantsTool
        ? [{ type: 'tool_use', id: 'toolu_1', name: TOOL, input: { q: k.args } }]
        : [{ type: 'text', text: answer }];
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id, type: 'message', role: 'assistant', model, content,
          stop_reason: wantsTool ? 'tool_use' : 'end_turn', stop_sequence: null,
          usage: { input_tokens: USAGE.input, output_tokens: USAGE.output },
        }));
        return;
      }
      const ev = (type, data) => sseWrite(res, { type, ...data }, type);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      ev('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: USAGE.input, output_tokens: 1 } } });
      if (wantsTool) {
        ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: TOOL, input: {} } });
        ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: args } });
      } else {
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: slow ? k.result : answer } });
        if (slow) { hold(); return; }
      }
      ev('content_block_stop', { index: 0 });
      ev('message_delta', { delta: { stop_reason: wantsTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: USAGE.output } });
      ev('message_stop', {});
      res.end();
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  c.cleanup(() => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }));
  return { hits, url: `http://127.0.0.1:${server.address().port}` };
}


/**
 * An AER API that accepts every connection and never answers: the slow or
 * blackholed case, as opposed to a refused port, which fails at once.
 */
export async function startHangingApi(c) {
  const sockets = new Set();
  let accepted = 0;
  const server = createTcpServer((s) => { accepted += 1; sockets.add(s); s.on('error', () => undefined); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  c.cleanup(() => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }));
  return { url: `http://127.0.0.1:${server.address().port}`, accepted: () => accepted };
}

/** Workload lines that time each call from process start, into out.t. */
const TIMED = `
  out.t = [];
  const timed = async (fn) => { const s = performance.now(); await fn(); out.t.push([Math.round(s), Math.round(performance.now() - s)]); };
`;

// ---------------------------------------------------------------------------
// The customer project: the candidate collector plus the pinned SDK, installed
// once per run.

let project;
function vercelProject(env) {
  if (!project) {
    project = (async () => {
      const dir = join(env.workRoot, 'vercel-ai');
      mkdirSync(dir, { recursive: true });
      const specs = {
        [PKG]: { spec: env.install.spec(PKG) },
        ...Object.fromEntries(Object.entries(VERCEL_PINS).map(([n, v]) => [n, { spec: `${n}@${v}` }])),
      };
      await installInto(dir, specs, { log: env.log, npmEnv: env.npmEnv, retryMinutes: 1, registry: env.opts.source === 'registry' });
      const nm = join(dir, 'node_modules');
      for (const [n, v] of Object.entries(VERCEL_PINS)) {
        const f = join(nm, n, 'package.json');
        if (!existsSync(f)) throw new Error(`${n} did not install`);
        const got = JSON.parse(readFileSync(f, 'utf8')).version;
        if (got !== v) throw new Error(`${n} installed ${got}, pinned ${v}`);
      }
      if (env.thirdParty) Object.assign(env.thirdParty, VERCEL_PINS);
      return nm;
    })().catch((err) => ({ skip: `could not install the Vercel AI SDK from npm: ${String(err.message ?? err).split('\n')[0]}` }));
  }
  return project;
}

/** The workload prelude: providers built against the local server, canaries parsed. */
const PRELUDE = `
  import * as ai from 'ai';
  import { createOpenAI } from '@ai-sdk/openai';
  import { createAnthropic } from '@ai-sdk/anthropic';
  import { z } from 'zod';
  const k = JSON.parse(process.env.MX);
  const openai = createOpenAI({ apiKey: 'sk-' + k.secret, baseURL: process.env.PROVIDER + '/v1' });
  const anthropic = createAnthropic({ apiKey: 'sk-ant-' + k.secret, baseURL: process.env.PROVIDER + '/v1' });
  const tools = {
    ${TOOL}: ai.tool({
      description: 'look something up',
      inputSchema: z.object({ q: z.string() }),
      execute: async ({ q }) => (q === k.args ? k.result : 'unexpected arguments'),
    }),
  };
  const out = {};
`;

async function vercelRun(c, nm, { sink, provider, k, config = {}, workload, env = {}, timeoutMs }) {
  return runWorkload(c, {
    nodeModules: nm,
    config: { ...IDS(), base_url: sink.url, ...config },
    env: { MX: JSON.stringify(k), PROVIDER: provider.url, ...env },
    workload: `${PRELUDE}\n${workload}\nconsole.log(JSON.stringify(out));`,
    timeoutMs,
  });
}

const llm = (sink, provider) => ({
  req: byType(sink.events(), 'llm.requested').filter((e) => !provider || e.payload.provider === provider),
  done: byType(sink.events(), 'llm.completed').filter((e) => !provider || e.payload.provider === provider),
  tools: byType(sink.events(), 'tool.selected').filter((e) => !provider || e.payload.provider === provider),
});

function assertCall(c, e, { provider, model = 'mx-model', streaming, tokens = true }, what) {
  c.assert.equal(e?.payload?.provider, provider, `${what}: provider`);
  c.assert.equal(e?.payload?.model, model, `${what}: model`);
  c.assert.equal(e?.payload?.ok, true, `${what}: ok`);
  if (streaming !== undefined) c.assert.equal(Boolean(e.payload.streaming), streaming, `${what}: streaming`);
  if (tokens) {
    c.assert.equal(e.payload.input_tokens, USAGE.input, `${what}: input_tokens`);
    c.assert.equal(e.payload.output_tokens, USAGE.output, `${what}: output_tokens`);
  }
}

const finalReport = (sink) => byType(sink.events(), 'collector.report').filter((e) => e.payload?.phase === 'final').pop();
const adapterRow = (sink, name) => (finalReport(sink)?.payload?.adapters ?? []).find((a) => a.name === name);

// ---------------------------------------------------------------------------

export default function register(registry, env) {
  const t = registry.suite('vercel-ai', `${PKG} with ai@${VERCEL_PINS.ai}`);

  const vcase = (title, fn) => t.case(title, async (c) => {
    const nm = await vercelProject(env);
    if (nm.skip) return nm;
    c.note(Object.entries(VERCEL_PINS).map(([n, v]) => `${n}@${v}`).join(', '));
    return fn(c, nm);
  }, { timeoutMs: 600_000 });

  vcase('generateText: openai responses and chat models, one event pair per model call, bodies-off', async (c, nm) => {
    const sink = await c.sink();
    const k = canaries('VAIGEN');
    const provider = await startVercelProvider(c, k);
    const r = await vercelRun(c, nm, {
      sink, provider, k,
      workload: `
        const a = await ai.generateText({ model: openai('mx-model'), system: k.prompt, prompt: k.prompt });
        const b = await ai.generateText({ model: openai.chat('mx-model'), prompt: k.prompt });
        out.ok = a.text === k.result && b.text === k.result;
        out.usage = [a.usage.inputTokens, a.usage.outputTokens];
      `,
    });
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(r.json?.ok, true, 'the SDK returned the provider text unchanged');
    c.assert.equal(JSON.stringify(provider.hits.map((h) => h.url)), JSON.stringify(['/v1/responses', '/v1/chat/completions']), 'provider endpoints');
    c.assert.includes(provider.hits[0].body, k.prompt, 'prompt at the provider');
    const { req, done } = llm(sink, 'openai');
    c.assert.equal(req.length, 2, 'llm.requested');
    c.assert.equal(done.length, 2, 'llm.completed');
    for (const e of req) c.assert.equal(e.payload.model, 'mx-model', 'llm.requested model');
    done.forEach((e, i) => assertCall(c, e, { provider: 'openai', streaming: false }, `llm.completed ${i}`));
    c.assert.equal(llm(sink).tools.length, 0, 'tool.selected without a tool call');
    c.assert.equal(adapterRow(sink, 'vercel-provider')?.coverage, 'confirmed', 'vercel-provider coverage');
    assertNoCanaries(sink.allText(), k);
    assertCompletedOnce(c, sink);
  });

  vcase('tool calling: a two-step generateText loop records both calls and the tool name only', async (c, nm) => {
    const sink = await c.sink();
    const k = canaries('VAITOOL');
    const provider = await startVercelProvider(c, k);
    const r = await vercelRun(c, nm, {
      sink, provider, k,
      workload: `
        const res = await ai.generateText({ model: openai('mx-model'), prompt: k.prompt, tools, stopWhen: ai.stepCountIs(3) });
        out.steps = res.steps.length;
        out.toolResult = res.steps[0]?.toolResults?.[0]?.output === k.result;
        out.ok = res.text === k.result;
      `,
    });
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(r.json?.steps, 2, 'steps');
    c.assert.equal(r.json?.toolResult, true, 'the tool ran with the model arguments');
    c.assert.equal(r.json?.ok, true, 'final text');
    c.assert.includes(provider.hits[1]?.body, k.result, 'tool result fed back to the provider');
    const { req, done, tools } = llm(sink, 'openai');
    c.assert.equal(req.length, 2, 'llm.requested, one per step');
    c.assert.equal(done.length, 2, 'llm.completed, one per step');
    done.forEach((e, i) => assertCall(c, e, { provider: 'openai', streaming: false }, `step ${i}`));
    c.assert.equal(done[0].payload.stop_reason, 'tool-calls', 'first step stop_reason');
    c.assert.equal(tools.length, 1, `tool.selected events: ${JSON.stringify(llm(sink).tools.map((e) => e.payload))}`);
    c.assert.equal(tools[0].payload.tool, TOOL, 'tool name');
    c.assert.equal(JSON.stringify(Object.keys(tools[0].payload).sort()), JSON.stringify(['provider', 'tool']), 'tool.selected carries the name only');
    assertNoCanaries(sink.allText(), k);
    assertCompletedOnce(c, sink);
  });

  vcase('streamText consumed fully: text and tool streams complete with tokens and tool names', async (c, nm) => {
    const sink = await c.sink();
    const k = canaries('VAISTREAM');
    const provider = await startVercelProvider(c, k);
    const r = await vercelRun(c, nm, {
      sink, provider, k,
      workload: `
        const s = ai.streamText({ model: openai('mx-model'), prompt: k.prompt });
        let text = '';
        for await (const part of s.textStream) text += part;
        const t = ai.streamText({ model: openai.chat('mx-model'), prompt: k.prompt, tools });
        const names = [];
        for await (const part of t.fullStream) if (part.type === 'tool-call') names.push(part.toolName);
        out.ok = text === k.result && names.join() === '${TOOL}';
        out.usage = (await s.usage).outputTokens;
      `,
    });
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(r.json?.ok, true, 'the stream carried the provider content unchanged');
    c.assert.ok(provider.hits.every((h) => h.stream), 'every provider request was a stream');
    const { req, done, tools } = llm(sink, 'openai');
    c.assert.equal(req.length, 2, 'llm.requested');
    for (const e of req) c.assert.equal(e.payload.streaming, true, 'llm.requested streaming');
    c.assert.equal(done.length, 2, 'llm.completed');
    done.forEach((e, i) => assertCall(c, e, { provider: 'openai', streaming: true }, `stream ${i}`));
    c.assert.equal(tools.length, 1, `tool.selected events: ${JSON.stringify(tools.map((e) => e.payload))}`);
    c.assert.equal(tools[0].payload.tool, TOOL, 'streamed tool name');
    assertNoCanaries(sink.allText(), k);
    assertCompletedOnce(c, sink);
  });

  vcase('streamText aborted midway: the host sees the abort, one failed completion, the session still closes', async (c, nm) => {
    const sink = await c.sink();
    const k = canaries('VAIABORT');
    const provider = await startVercelProvider(c, k);
    const r = await vercelRun(c, nm, {
      sink, provider, k,
      timeoutMs: 45_000,
      workload: `
        const ac = new AbortController();
        const s = ai.streamText({ model: openai('mx-model'), prompt: 'MX_SLOW ' + k.prompt, abortSignal: ac.signal, onError: () => {} });
        let text = '';
        try {
          for await (const part of s.textStream) { text += part; ac.abort(); }
        } catch (err) { out.threw = err?.name ?? String(err); }
        out.partial = text === k.result;
        out.aborted = ac.signal.aborted;
      `,
    });
    c.assert.ok(!r.timedOut, 'the workload hung after the abort');
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(r.json?.partial, true, 'the first delta reached the host before the abort');
    c.assert.equal(r.json?.aborted, true, 'aborted');
    const { req, done } = llm(sink, 'openai');
    c.assert.equal(req.length, 1, 'llm.requested');
    c.assert.equal(done.length, 1, `llm.completed after an abort: ${JSON.stringify(done.map((e) => e.payload))}`);
    c.assert.equal(done[0].payload.ok, false, 'an aborted stream is not recorded as a success');
    assertNoCanaries(sink.allText(), k);
    assertCompletedOnce(c, sink);
    c.note(`host saw ${r.json?.threw ?? 'no exception'}; completion ${JSON.stringify(done[0].payload)}`);
  });

  vcase('generateObject and streamObject: structured output recorded as model calls, the object never', async (c, nm) => {
    const sink = await c.sink();
    const k = canaries('VAIOBJ');
    const provider = await startVercelProvider(c, k);
    const r = await vercelRun(c, nm, {
      sink, provider, k,
      workload: `
        const schema = z.object({ answer: z.string() });
        const g = await ai.generateObject({ model: openai('mx-model'), schema, prompt: k.prompt });
        const s = ai.streamObject({ model: openai.chat('mx-model'), schema, prompt: k.prompt });
        for await (const _ of s.partialObjectStream) { /* the result settles as the stream is read */ }
        const obj = await s.object;
        out.ok = g.object.answer === k.result && obj.answer === k.result;
      `,
    });
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(r.json?.ok, true, 'the SDK parsed the provider object');
    const { req, done } = llm(sink, 'openai');
    c.assert.equal(req.length, 2, 'llm.requested');
    c.assert.equal(done.length, 2, 'llm.completed');
    assertCall(c, done.find((e) => !e.payload.streaming), { provider: 'openai', streaming: false }, 'generateObject');
    assertCall(c, done.find((e) => e.payload.streaming), { provider: 'openai', streaming: true }, 'streamObject');
    assertNoCanaries(sink.allText(), k);
    assertCompletedOnce(c, sink);
  });

  vcase('anthropic provider: generateText, streamText and a tool loop through @ai-sdk/anthropic', async (c, nm) => {
    const sink = await c.sink();
    const k = canaries('VAIANT');
    const provider = await startVercelProvider(c, k);
    const r = await vercelRun(c, nm, {
      sink, provider, k,
      workload: `
        const model = anthropic('mx-model');
        const a = await ai.generateText({ model, system: k.prompt, prompt: k.prompt });
        const s = ai.streamText({ model, prompt: k.prompt });
        let text = '';
        for await (const part of s.textStream) text += part;
        const loop = await ai.generateText({ model, prompt: k.prompt, tools, stopWhen: ai.stepCountIs(3) });
        out.ok = a.text === k.result && text === k.result && loop.text === k.result && loop.steps.length === 2;
      `,
    });
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(r.json?.ok, true, 'the SDK returned the provider content unchanged');
    c.assert.ok(provider.hits.every((h) => h.url === '/v1/messages'), 'anthropic endpoint');
    const { req, done, tools } = llm(sink, 'anthropic');
    c.assert.equal(req.length, 4, 'llm.requested: generate, stream and two loop steps');
    c.assert.equal(done.length, 4, 'llm.completed');
    done.forEach((e, i) => assertCall(c, e, { provider: 'anthropic' }, `call ${i}`));
    c.assert.equal(done.filter((e) => e.payload.streaming).length, 1, 'one streamed completion');
    c.assert.equal(tools.length, 1, `tool.selected events: ${JSON.stringify(tools.map((e) => e.payload))}`);
    c.assert.equal(tools[0].payload.tool, TOOL, 'tool name');
    assertNoCanaries(sink.allText(), k);
    assertCompletedOnce(c, sink);
  });

  vcase('google, mistral and groq providers: generateText and streamText recorded with model and tokens', async (c, nm) => {
    const sink = await c.sink();
    const k = canaries('VAIMORE');
    const provider = await startVercelProvider(c, k);
    const r = await vercelRun(c, nm, {
      sink, provider, k,
      workload: `
        const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
        const { createMistral } = await import('@ai-sdk/mistral');
        const { createGroq } = await import('@ai-sdk/groq');
        const models = {
          google: createGoogleGenerativeAI({ apiKey: 'g-' + k.secret, baseURL: process.env.PROVIDER + '/v1beta' })('mx-model'),
          mistral: createMistral({ apiKey: 'm-' + k.secret, baseURL: process.env.PROVIDER + '/v1' })('mx-model'),
          groq: createGroq({ apiKey: 'q-' + k.secret, baseURL: process.env.PROVIDER + '/v1' })('mx-model'),
        };
        out.got = {};
        for (const [name, model] of Object.entries(models)) {
          const a = await ai.generateText({ model, prompt: k.prompt });
          const s = ai.streamText({ model, prompt: k.prompt });
          let text = '';
          for await (const part of s.textStream) text += part;
          out.got[name] = a.text === k.result && text === k.result;
        }
      `,
    });
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(JSON.stringify(r.json?.got), JSON.stringify({ google: true, mistral: true, groq: true }), 'each provider returned the text unchanged');
    for (const name of ['google', 'mistral', 'groq']) {
      const { req, done } = llm(sink, name);
      c.assert.equal(req.length, 2, `${name} llm.requested`);
      c.assert.equal(done.length, 2, `${name} llm.completed: ${JSON.stringify(llm(sink).done.map((e) => e.payload))}`);
      assertCall(c, done.find((e) => !e.payload.streaming), { provider: name, streaming: false }, `${name} generateText`);
      assertCall(c, done.find((e) => e.payload.streaming), { provider: name, streaming: true }, `${name} streamText`);
    }
    assertNoCanaries(sink.allText(), k);
    assertCompletedOnce(c, sink);
  });

  vcase('model unknown: an uninstrumented provider invents no call and the record says unverifiable, not idle', async (c, nm) => {
    const sink = await c.sink();
    const k = canaries('VAIUNK');
    const provider = await startVercelProvider(c, k);
    const r = await vercelRun(c, nm, {
      sink, provider, k,
      workload: `
        const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
        const other = createOpenAICompatible({ name: 'mx-gateway', apiKey: 'sk-' + k.secret, baseURL: process.env.PROVIDER + '/v1' });
        const a = await ai.generateText({ model: other('mx-unknown-model'), prompt: k.prompt });
        out.ok = a.text === k.result;
      `,
    });
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(r.json?.ok, true, 'the call went through');
    c.assert.equal(provider.hits.length, 1, 'provider hits');
    const { req, done } = llm(sink);
    c.assert.equal(req.length + done.length, 0, `llm events for a provider the collector does not instrument: ${JSON.stringify([...req, ...done].map((e) => e.payload))}`);
    c.assert.ok(byType(sink.events(), 'http.requested').some((e) => String(e.payload.host).startsWith('127.0.0.1')), 'the request itself was recorded by host');
    const row = adapterRow(sink, 'vercel-provider');
    c.assert.ok(row, `no vercel-provider row in the final report: ${JSON.stringify(finalReport(sink)?.payload?.adapters)}`);
    c.assert.equal(row.coverage, 'unverifiable', 'vercel-provider coverage with model traffic it did not see');
    c.assert.equal(row.calls_recorded, 0, 'calls_recorded');
    assertNoCanaries(sink.allText(), k);
    assertCompletedOnce(c, sink);
  });

  const blockPolicy = (agentId) => ({
    policy_id: randomUUID(), agent_id: agentId, version: 1, mode: 'block', on_unavailable: 'fail_open',
    llm: { denied_models: ['mx-denied-*'] },
  });

  vcase('usage policy block: a denied model is refused before any request leaves, on the first call', async (c, nm) => {
    const sink = await c.sink();
    const k = canaries('VAIPOL');
    const provider = await startVercelProvider(c, k);
    const ids = IDS();
    sink.policies.set(ids.agent_id, blockPolicy(ids.agent_id));
    const r = await vercelRun(c, nm, {
      sink, provider, k,
      config: ids,
      workload: `
        const { AerPolicyError } = await import('${PKG}');
        const attempt = async (fn) => { try { await fn(); return 'sent'; } catch (err) { return err instanceof AerPolicyError ? 'blocked:' + err.rule : 'error:' + (err?.name ?? err); } };
        out.first = await attempt(() => ai.generateText({ model: openai('mx-denied-1'), prompt: k.prompt, maxRetries: 0 }));
        out.stream = await attempt(async () => {
          const s = ai.streamText({ model: openai('mx-denied-2'), prompt: k.prompt, maxRetries: 0, onError: () => {} });
          for await (const _ of s.fullStream) { if (_.type === 'error') throw _.error; }
        });
        out.allowed = await attempt(() => ai.generateText({ model: openai('mx-model'), prompt: k.prompt }));
      `,
    });
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(r.json?.first, 'blocked:model_denied', 'the first call, to a denied model');
    c.assert.equal(r.json?.stream, 'blocked:model_denied', 'a streamed call to a denied model');
    c.assert.equal(r.json?.allowed, 'sent', 'a call to an allowed model');
    c.assert.equal(JSON.stringify(provider.hits.map((h) => h.model)), JSON.stringify(['mx-model']), 'only the allowed model reached the provider');
    const applied = byType(sink.events(), 'policy.applied');
    c.assert.equal(applied.length, 1, 'policy.applied');
    const v = byType(sink.events(), 'policy.violation');
    c.assert.equal(v.length, 2, `policy.violation: ${JSON.stringify(v.map((e) => e.payload))}`);
    c.assert.ok(v.every((e) => e.payload.rule === 'model_denied' && e.payload.action === 'block'), 'violation rule and action');
    c.assert.equal(JSON.stringify(v.map((e) => e.payload.model)), JSON.stringify(['mx-denied-1', 'mx-denied-2']), 'violation models');
    assertNoCanaries(sink.allText(), k);
    assertCompletedOnce(c, sink);
  });

  vcase('hanging AER API: only a call racing the first policy fetch waits, never past 3 s from its start', async (c, nm) => {
    const api = await startHangingApi(c);
    const k = canaries('VAIHANG');
    const provider = await startVercelProvider(c, k);
    const r = await vercelRun(c, nm, {
      sink: api, provider, k,
      timeoutMs: 60_000,
      workload: `${TIMED}
        await timed(() => ai.generateText({ model: openai('mx-model'), prompt: k.prompt }));
        await timed(() => ai.generateText({ model: anthropic('mx-model'), prompt: k.prompt }));
        await timed(async () => { const s = ai.streamText({ model: openai('mx-model'), prompt: k.prompt }); for await (const _ of s.textStream) {} });
        out.ok = true;
      `,
    });
    c.assert.ok(!r.timedOut, 'the workload hung with the AER API not answering');
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(r.json?.ok, true, 'workload finished');
    const [[start0, first], ...rest] = r.json.t;
    // The policy fetch starts with the collector, before the workload's own
    // imports, so the first call waits at most what is left of its 3 s.
    c.assert.ok(start0 + first < 3_000 + 500, `first call ended ${start0 + first} ms after process start (waited ${first} ms)`);
    for (const [, ms] of rest) c.assert.ok(ms < 500, `a later call took ${ms} ms; nothing may wait once the bound has passed`);
    c.assert.ok(api.accepted() > 0, 'the collector never reached the hanging API');
    c.assert.equal(provider.hits.length, 3, 'every call reached the provider (fail-open)');
    // Each request to the AER API is abandoned after 10 s, so the host exits.
    c.assert.ok(r.ms < 30_000, `the host took ${r.ms} ms to exit`);
    c.note(`call times (start, duration) ms: ${JSON.stringify(r.json.t)}; exit after ${r.ms} ms`);
  });

  vcase('policy answered, the rest of the AER API hanging: no call waits at all', async (c, nm) => {
    const sink = await c.sink();
    const k = canaries('VAIHANG2');
    const provider = await startVercelProvider(c, k);
    const ids = IDS();
    sink.policies.set(ids.agent_id, { policy_id: randomUUID(), agent_id: ids.agent_id, version: 1, mode: 'report', on_unavailable: 'fail_open', llm: { denied_models: ['nothing-*'] } });
    // Session open never answers, so every recording path is stuck.
    sink.route('POST', '/v1/sessions', () => new Promise(() => undefined));
    const r = await vercelRun(c, nm, {
      sink, provider, k,
      config: ids,
      timeoutMs: 60_000,
      workload: `${TIMED}
        // Let the collector's startup fetch land before the first call.
        await new Promise((r) => setTimeout(r, 300));
        await timed(() => ai.generateText({ model: openai('mx-model'), prompt: k.prompt }));
        await timed(() => ai.generateText({ model: anthropic('mx-model'), prompt: k.prompt }));
        await timed(async () => { const s = ai.streamText({ model: openai('mx-model'), prompt: k.prompt }); for await (const _ of s.textStream) {} });
        out.ok = true;
      `,
    });
    c.assert.ok(!r.timedOut, 'the workload hung with session open not answering');
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(sink.find('GET', /\/usage-policy$/).length, 1, 'one policy fetch for the whole process');
    for (const [, ms] of r.json.t) c.assert.ok(ms < 300, `a call took ${ms} ms with the policy already known`);
    c.assert.ok(r.ms < 30_000, `the host took ${r.ms} ms to exit`);
    c.note(`call times (start, duration) ms: ${JSON.stringify(r.json.t)}; exit after ${r.ms} ms`);
  });

  vcase('sink down: every Vercel path still returns on time with its own result intact', async (c, nm) => {
    const k = canaries('VAIDOWN');
    const provider = await startVercelProvider(c, k);
    const r = await vercelRun(c, nm, {
      sink: { url: 'http://127.0.0.1:9' }, provider, k,
      timeoutMs: 30_000,
      workload: `
        const a = await ai.generateText({ model: openai('mx-model'), prompt: k.prompt, tools, stopWhen: ai.stepCountIs(3) });
        const s = ai.streamText({ model: anthropic('mx-model'), prompt: k.prompt });
        let text = '';
        for await (const part of s.textStream) text += part;
        out.ok = a.text === k.result && text === k.result;
      `,
    });
    c.assert.ok(!r.timedOut, 'the workload hung with the AER API unreachable');
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(r.json?.ok, true, 'host results');
    c.assert.ok(r.ms < 20_000, `workload took ${r.ms} ms`);
    c.note(`exit after ${r.ms} ms`);
  });

  // ---- live, opt-in ---------------------------------------------------------

  // Real provider APIs, not api.aer.run: a suite of their own.
  const live = registry.suite('vercel-ai-live', 'real provider APIs');
  const keys = [
    ['openai', 'MATRIX_OPENAI_API_KEY', 'MATRIX_OPENAI_MODEL', 'gpt-4o-mini'],
    ['anthropic', 'MATRIX_ANTHROPIC_API_KEY', 'MATRIX_ANTHROPIC_MODEL', 'claude-haiku-4-5'],
  ];
  for (const [name, keyVar, modelVar, defaultModel] of keys) {
    const title = `vercel ai against the real ${name} API, recorded to a local sink`;
    if (!env.opts.live) { live.skip(title, 'runs only with --live'); continue; }
    // Read from the runner's environment only when explicitly supplied.
    const key = process.env[keyVar];
    if (!key) { live.skip(title, `set ${keyVar} to run it; no key is read from disk`); continue; }
    live.case(title, async (c) => {
      const nm = await vercelProject(env);
      if (nm.skip) return nm;
      const sink = await c.sink();
      const k = canaries('VAILIVE');
      const model = process.env[modelVar] || defaultModel;
      const factory = name === 'openai' ? 'createOpenAI' : 'createAnthropic';
      const pkg = name === 'openai' ? '@ai-sdk/openai' : '@ai-sdk/anthropic';
      const r = await runWorkload(c, {
        nodeModules: nm,
        config: { ...IDS(), base_url: sink.url },
        // The provider is real, so this one process gets the network. The
        // sink is still the local one; the collector never sees production.
        env: {
          MX: JSON.stringify(k), PROVIDER_KEY: key, MODEL: model,
          NODE_USE_ENV_PROXY: undefined, HTTP_PROXY: undefined, HTTPS_PROXY: undefined, http_proxy: undefined, https_proxy: undefined,
        },
        timeoutMs: 120_000,
        workload: `
          import * as ai from 'ai';
          import { ${factory} } from '${pkg}';
          const k = JSON.parse(process.env.MX);
          const p = ${factory}({ apiKey: process.env.PROVIDER_KEY });
          const a = await ai.generateText({ model: p(process.env.MODEL), prompt: 'Reply with the single word ok. ' + k.prompt, maxOutputTokens: 16 });
          const s = ai.streamText({ model: p(process.env.MODEL), prompt: 'Reply with the single word ok. ' + k.prompt, maxOutputTokens: 16 });
          for await (const _ of s.textStream) {}
          console.log(JSON.stringify({ ok: typeof a.text === 'string' }));
        `,
      });
      c.assert.exit(r, 0, 'workload');
      const done = byType(sink.events(), 'llm.completed').filter((e) => e.payload.provider === name);
      c.assert.equal(done.length, 2, 'llm.completed');
      for (const e of done) {
        c.assert.equal(e.payload.ok, true, 'ok');
        c.assert.ok(e.payload.input_tokens > 0 && e.payload.output_tokens > 0, `token counts: ${JSON.stringify(e.payload)}`);
      }
      assertNoCanaries(sink.allText(), k);
      c.assert.excludes(sink.allText(), key, 'the provider key reached the sink');
      c.note(`${name} ${model}: ${done.map((e) => `${e.payload.model} ${e.payload.input_tokens}/${e.payload.output_tokens}`).join(', ')}`);
    }, { timeoutMs: 600_000 });
  }
}
