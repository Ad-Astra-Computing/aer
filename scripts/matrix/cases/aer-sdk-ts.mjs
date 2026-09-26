/**
 * aer-sdk-ts, driven from a fresh Node process that resolves the installed
 * package. The script opens its own session over HTTP, as the README shows,
 * then uses createAerClient against it.
 */
import { randomUUID } from 'node:crypto';
import { deadPort } from '../lib/sink.mjs';

const PKG = '@adastracomputing/aer-sdk-ts';

/**
 * Open a session on `openUrl`, then run `body` with `client` bound to
 * `ingestUrl` (a dead port for the sink-down cases). Prints one JSON line.
 */
function script({ openUrl, ingestUrl, body, clientOpts = '' }) {
  return `
import { createAerClient } from '${PKG}';
const out = { steps: [] };
const res = await fetch(${JSON.stringify(openUrl)} + '/v1/sessions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer mx_key_${randomUUID()}' },
  body: JSON.stringify({ tenant_id: '${randomUUID()}', agent_id: '${randomUUID()}', agent_version: '1.0.0', environment_id: '${randomUUID()}' }),
});
const { agent_session_id, ingest_token } = await res.json();
out.session = agent_session_id;
const client = createAerClient({ baseUrl: ${JSON.stringify(ingestUrl ?? openUrl)}, sessionId: agent_session_id, ingestToken: ingest_token, retryBaseMs: 20, requestTimeoutMs: 3000 ${clientOpts} });
const step = async (name, fn) => {
  try { const v = await fn(); out.steps.push([name, 'ok', v === undefined ? null : v]); }
  catch (e) { out.steps.push([name, 'rejected', String(e && e.message).slice(0, 200)]); }
};
${body}
console.log(JSON.stringify(out));
`;
}

function seqs(sink) {
  const ids = new Set();
  const s = new Set();
  for (const e of sink.events()) {
    if (ids.has(e.event_id)) continue;
    ids.add(e.event_id);
    if (typeof e.payload?.seq === 'number') s.add(e.payload.seq);
  }
  return { unique: ids.size, seqs: s };
}

const stepOf = (out, name) => out.steps.find((s) => s[0] === name);

export default function register(registry) {
  const t = registry.suite('aer-sdk-ts', PKG);

  t.case('burst of 2000 awaited emits: zero loss, complete then close', async (c) => {
    const sink = await c.sink();
    const r = await c.node(script({ openUrl: sink.url, body: `
await step('emit', async () => { for (let i = 0; i < 2000; i++) await client.emit('tool.started', { tool: 'mx', seq: i }); });
await step('complete', () => client.complete().then((x) => x.aer_id ? 'aer' : 'none'));
await step('close', () => client.close());
` }), { timeoutMs: 60_000 });
    c.assert.exit(r, 0, 'sdk script');
    for (const s of r.json.steps) c.assert.equal(s[1], 'ok', `${s[0]} (${s[2]})`);
    const got = seqs(sink);
    c.assert.equal(got.unique, 2000, 'unique events received');
    c.assert.equal(got.seqs.size, 2000, 'distinct seq values received');
    c.assert.equal(sink.find('POST', /\/complete$/).length, 1, '/complete calls');
    for (const e of sink.events().slice(0, 5)) {
      c.assert.equal(e.source_type, 'sdk', 'source_type');
      c.assert.match(e.event_id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/, 'event_id is a UUIDv7');
    }
  });

  t.case('burst of 2000 un-awaited emits then complete(): zero loss, /complete last', async (c) => {
    const sink = await c.sink();
    sink.route('POST', /^\/v1\/sessions\/[^/]+\/events$/, async () => {
      await new Promise((res) => setTimeout(res, 20));
      return false;
    });
    const r = await c.node(script({ openUrl: sink.url, body: `
const pending = [];
for (let i = 0; i < 2000; i++) pending.push(client.emit('tool.started', { tool: 'mx', seq: i }));
await step('complete', () => client.complete().then(() => 'done'));
await step('emits settled', () => Promise.all(pending).then(() => pending.length));
await step('close', () => client.close());
` }), { timeoutMs: 60_000 });
    c.assert.exit(r, 0, 'sdk script');
    for (const s of r.json.steps) c.assert.equal(s[1], 'ok', `${s[0]} (${s[2]})`);
    c.assert.equal(seqs(sink).seqs.size, 2000, 'events delivered');
    const complete = sink.find('POST', /\/complete$/);
    c.assert.equal(complete.length, 1, '/complete calls');
    const lastEvents = Math.max(...sink.find('POST', /\/events$/).map((q) => q.at));
    c.assert.ok(complete[0].at >= lastEvents, '/complete was sent before the last events batch');
  });

  t.case('close/flush race: close() right after emits drains the buffer', async (c) => {
    const sink = await c.sink();
    sink.route('POST', /^\/v1\/sessions\/[^/]+\/events$/, async () => {
      await new Promise((res) => setTimeout(res, 100));
      return false;
    });
    const r = await c.node(script({ openUrl: sink.url, body: `
for (let i = 0; i < 49; i++) await client.emit('tool.started', { tool: 'mx', seq: i });
const p = client.emit('tool.started', { tool: 'mx', seq: 49 });
for (let i = 50; i < 73; i++) client.emit('tool.started', { tool: 'mx', seq: i }).catch(() => {});
await step('close', () => client.close());
await step('emit after close', () => client.emit('tool.started', { tool: 'late' }));
await p;
` }), { timeoutMs: 60_000 });
    c.assert.exit(r, 0, 'sdk script');
    c.assert.equal(stepOf(r.json, 'close')[1], 'ok', 'close()');
    c.assert.equal(stepOf(r.json, 'emit after close')[1], 'rejected', 'emit after close is refused');
    c.assert.equal(seqs(sink).seqs.size, 73, 'events delivered before close resolved');
  });

  t.case('sink down: emit, complete and close reject; the caller is told', async (c) => {
    const sink = await c.sink();
    const port = await deadPort();
    const r = await c.node(script({ openUrl: sink.url, ingestUrl: `http://127.0.0.1:${port}`, body: `
await step('emit batch', async () => { for (let i = 0; i < 60; i++) await client.emit('tool.started', { seq: i }); });
await step('complete', () => client.complete());
await step('close', () => client.close());
` }), { timeoutMs: 60_000 });
    c.assert.exit(r, 0, 'sdk script');
    c.note(`observed: ${JSON.stringify(r.json.steps)}`);
    c.assert.equal(stepOf(r.json, 'emit batch')[1], 'rejected', 'emit crossing the batch size with the sink down');
    c.assert.equal(stepOf(r.json, 'complete')[1], 'rejected', 'complete() with the sink down');
    c.assert.equal(stepOf(r.json, 'close')[1], 'rejected', 'close() with the sink down');
  });

  for (const [status, label] of [[500, '500 on every attempt'], [503, '503 past the retry budget'], [413, '413 batch_too_large']]) {
    t.case(`events answer ${label}: flush and complete reject, events stay queued`, async (c) => {
      const sink = await c.sink();
      sink.fault({ method: 'POST', path: /\/events$/, status, body: { error: status === 413 ? 'batch_too_large' : 'injected' } });
      const r = await c.node(script({ openUrl: sink.url, body: `
for (let i = 0; i < 10; i++) await client.emit('tool.started', { seq: i });
await step('flush', () => client.flush());
await step('complete', () => client.complete());
` }), { timeoutMs: 60_000 });
      c.assert.exit(r, 0, 'sdk script');
      c.note(`observed: ${JSON.stringify(r.json.steps)}; events POSTs ${sink.find('POST', /\/events$/).length}; /complete ${sink.find('POST', /\/complete$/).length}`);
      c.assert.equal(stepOf(r.json, 'flush')[1], 'rejected', 'flush()');
      c.assert.equal(stepOf(r.json, 'complete')[1], 'rejected', 'complete()');
      c.assert.equal(sink.find('POST', /\/complete$/).length, 0, '/complete must not be sent over lost events');
    });
  }

  t.case('transient 503 on events is retried and nothing is lost', async (c) => {
    const sink = await c.sink();
    sink.fault({ method: 'POST', path: /\/events$/, status: 503, times: 2 });
    const r = await c.node(script({ openUrl: sink.url, body: `
for (let i = 0; i < 120; i++) await client.emit('tool.started', { seq: i });
await step('complete', () => client.complete().then(() => 'done'));
` }), { timeoutMs: 60_000 });
    c.assert.exit(r, 0, 'sdk script');
    c.assert.equal(stepOf(r.json, 'complete')[1], 'ok', 'complete()');
    c.assert.equal(seqs(sink).seqs.size, 120, 'events delivered after retries');
  });

  // The README says maxRetries "applies only to 5xx/network errors".
  t.case('a transient network error on events is retried, as the README states', async (c) => {
    const sink = await c.sink();
    sink.fault({ method: 'POST', path: /\/events$/, destroy: true, times: 1 });
    const r = await c.node(script({ openUrl: sink.url, body: `
await step('flush', async () => { for (let i = 0; i < 10; i++) await client.emit('tool.started', { seq: i }); return (await client.flush()).length; });
` }), { timeoutMs: 60_000 });
    c.assert.exit(r, 0, 'sdk script');
    c.note(`observed: ${JSON.stringify(r.json.steps)}; events POSTs ${sink.find('POST', /\/events$/).length}`);
    c.assert.equal(stepOf(r.json, 'flush')[1], 'ok', 'flush() after one dropped connection');
    c.assert.equal(seqs(sink).seqs.size, 10, 'events delivered');
  });

  t.case('abort() flushes then aborts the session', async (c) => {
    const sink = await c.sink();
    const r = await c.node(script({ openUrl: sink.url, body: `
for (let i = 0; i < 5; i++) await client.emit('tool.started', { seq: i });
await step('abort', () => client.abort());
` }), { timeoutMs: 60_000 });
    c.assert.exit(r, 0, 'sdk script');
    c.assert.equal(stepOf(r.json, 'abort')[1], 'ok', 'abort()');
    c.assert.equal(seqs(sink).seqs.size, 5, 'events flushed before abort');
    c.assert.equal(sink.find('POST', /\/abort$/).length, 1, '/abort calls');
    c.assert.equal([...sink.sessions.values()][0].status, 'aborted', 'session status');
  });
}
