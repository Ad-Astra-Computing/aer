/**
 * aer-emit, the shared best-effort emit core, driven from a fresh Node
 * process that resolves the installed package.
 *
 * The failure-mode rows are written as known issues: the sink swallows a
 * failed delivery by design ("never thrown"), and there is no programmatic
 * signal that events were lost. A record then completes as a success with
 * events missing. Each known row asserts the behaviour a caller needs (every
 * event delivered, or a failure reported through the API) and records what
 * was actually observed.
 */
import { randomUUID } from 'node:crypto';
import { deadPort } from '../lib/sink.mjs';

const PKG = '@adastracomputing/aer-emit';

/**
 * Emit `n` events through createHttpSink and close. Prints one JSON line:
 * what close() did, every onOpen and onComplete call.
 */
function script({ baseUrl, n, clientRef, closeImmediately = true, extra = '' }) {
  return `
import { createHttpSink, deriveClientRef } from '${PKG}';
const out = { onOpen: [], onComplete: [], closed: null, emitThrew: 0 };
const sink = createHttpSink({
  baseUrl: ${JSON.stringify(baseUrl)},
  apiKey: 'mx_key_${randomUUID()}',
  tenantId: '${randomUUID()}',
  agentId: '${randomUUID()}',
  environmentId: '${randomUUID()}',
  agentVersion: 'matrix/1',
  ${clientRef ? `clientRef: ${JSON.stringify(clientRef)},` : ''}
  requestTimeoutMs: 3000,
  onOpen: (i) => out.onOpen.push(i),
  onComplete: (ok) => out.onComplete.push(ok),
});
${extra}
for (let i = 0; i < ${n}; i++) {
  try { sink.emit('tool.started', { tool: 'mx', seq: i }); } catch { out.emitThrew++; }
}
${closeImmediately ? '' : 'await new Promise((r) => setTimeout(r, 300));'}
const started = Date.now();
try { await sink.close(); out.closed = 'resolved'; } catch (e) { out.closed = 'rejected: ' + e.message; }
out.closeMs = Date.now() - started;
console.log(JSON.stringify(out));
`;
}

function seqsReceived(sink) {
  const ids = new Set();
  const seqs = new Set();
  for (const e of sink.events()) {
    if (ids.has(e.event_id)) continue;
    ids.add(e.event_id);
    if (typeof e.payload?.seq === 'number') seqs.add(e.payload.seq);
  }
  return { unique: ids.size, seqs };
}

/**
 * Run a failure mode and assert the caller-facing contract: either every
 * event arrived or the API reported the loss (onComplete(false) or a
 * rejected close). Notes record exactly what happened.
 */
async function failureMode(c, { configure, n = 200, baseUrl }) {
  const sink = await c.sink();
  if (configure) configure(sink);
  const r = await c.node(script({ baseUrl: baseUrl ?? sink.url, n }), { timeoutMs: 90_000 });
  c.assert.exit(r, 0, 'emit script');
  const out = r.json;
  const got = seqsReceived(sink);
  const stored = [...sink.sessions.values()].reduce((a, s) => a + s.events.length, 0);
  c.note(`emitted ${n}; delivered and stored ${stored}; close() ${out.closed} after ${out.closeMs} ms; onOpen calls ${out.onOpen.length}; onComplete ${JSON.stringify(out.onComplete)}; /complete requests ${sink.find('POST', /\/complete$/).length}; stderr: ${r.stderr.trim().replace(/\n/g, ' | ') || '(empty)'}`);
  const told = out.onComplete.includes(false) || String(out.closed).startsWith('rejected');
  c.assert.ok(got.seqs.size === n && stored === n || told,
    `${n - stored} of ${n} events lost and the caller was not told: close() ${out.closed}, onComplete ${JSON.stringify(out.onComplete)}; only a stderr line reports it`);
}

export default function register(registry) {
  const t = registry.suite('aer-emit', PKG);

  t.case('burst of 2000 events: zero loss, one session, /complete called', async (c) => {
    const sink = await c.sink();
    const r = await c.node(script({ baseUrl: sink.url, n: 2000 }), { timeoutMs: 60_000 });
    c.assert.exit(r, 0, 'emit script');
    const got = seqsReceived(sink);
    c.assert.equal(got.unique, 2000, 'unique events received');
    c.assert.equal(got.seqs.size, 2000, 'distinct seq values received');
    c.assert.equal(sink.find('POST', '/v1/sessions').length, 1, 'session opens');
    c.assert.equal(sink.find('POST', /\/complete$/).length, 1, '/complete calls');
    c.assert.equal(JSON.stringify(r.json.onComplete), '[true]', 'onComplete');
    const maxBatch = Math.max(...sink.find('POST', /\/events$/).map((q) => q.json.length));
    c.assert.ok(maxBatch <= 500, `a batch of ${maxBatch} events exceeds the 500 per-post cap`);
    c.assert.equal(r.stderr.trim(), '', 'stderr on the happy path');
  });

  t.case('close/flush race: close right after a threshold flush loses nothing', async (c) => {
    const sink = await c.sink();
    // Slow every events POST so close() starts while an emit-triggered flush
    // is still in flight.
    sink.route('POST', /^\/v1\/sessions\/[^/]+\/events$/, async () => {
      await new Promise((res) => setTimeout(res, 150));
      return false;
    });
    const r = await c.node(script({ baseUrl: sink.url, n: 130 }), { timeoutMs: 60_000 });
    c.assert.exit(r, 0, 'emit script');
    c.assert.equal(seqsReceived(sink).seqs.size, 130, 'events delivered');
    const completes = sink.find('POST', /\/complete$/);
    c.assert.equal(completes.length, 1, '/complete calls');
    const lastEvents = Math.max(...sink.find('POST', /\/events$/).map((q) => q.at));
    c.assert.ok(completes[0].at >= lastEvents, '/complete was sent before the last events batch');
  });

  t.case('an idle sink never touches the network', async (c) => {
    const sink = await c.sink();
    const r = await c.node(script({ baseUrl: sink.url, n: 0 }), { timeoutMs: 30_000 });
    c.assert.exit(r, 0, 'emit script');
    c.assert.equal(sink.requests.length, 0, 'requests from an idle sink');
  });

  t.case('client_ref: a second open reuses the running session', async (c) => {
    const sink = await c.sink();
    const ref = `mx-${randomUUID()}`;
    const extra = `
const second = createHttpSink({ baseUrl: ${JSON.stringify(sink.url)}, apiKey: 'k', tenantId: 't', agentId: 'a', clientRef: ${JSON.stringify(ref)}, completeOnClose: false, onOpen: (i) => out.onOpen.push(i) });
second.emit('tool.started', { tool: 'first' });
await second.close();
`;
    const r = await c.node(script({ baseUrl: sink.url, n: 5, clientRef: ref, extra }), { timeoutMs: 30_000 });
    c.assert.exit(r, 0, 'emit script');
    c.assert.equal(sink.sessions.size, 1, 'sessions created');
    const opens = r.json.onOpen;
    c.assert.equal(opens.length, 2, 'onOpen calls');
    c.assert.equal(opens[0].id, opens[1].id, 'both sinks on one session');
    c.assert.equal(opens[1].reused, true, 'second open marked reused');
    c.assert.equal(sink.find('POST', '/v1/sessions')[1].json.client_ref, ref, 'client_ref sent');
  });

  t.case('client_ref: a server that rejects the field gets one retry without it', async (c) => {
    const sink = await c.sink();
    let first = true;
    sink.route('POST', '/v1/sessions', (req, res, x) => {
      if (first && req.json?.client_ref) {
        first = false;
        x.json(400, { error: 'invalid_body', message: 'Unrecognized key: client_ref' });
        return true;
      }
      return false;
    });
    const r = await c.node(script({ baseUrl: sink.url, n: 10, clientRef: `mx-${randomUUID()}` }), { timeoutMs: 30_000 });
    c.assert.exit(r, 0, 'emit script');
    const opens = sink.find('POST', '/v1/sessions');
    c.assert.equal(opens.length, 2, 'session open attempts');
    c.assert.equal(opens[1].json.client_ref, undefined, 'retry still carried client_ref');
    c.assert.equal(seqsReceived(sink).seqs.size, 10, 'events delivered after the retry');
  });

  t.case('transient 503 on events is retried and nothing is lost', async (c) => {
    const sink = await c.sink();
    sink.fault({ method: 'POST', path: /\/events$/, status: 503, times: 2 });
    const r = await c.node(script({ baseUrl: sink.url, n: 100 }), { timeoutMs: 60_000 });
    c.assert.exit(r, 0, 'emit script');
    c.assert.equal(seqsReceived(sink).seqs.size, 100, 'events delivered after retries');
  });

  t.case('sink down: close() resolves promptly and the producer is unaffected', async (c) => {
    const port = await deadPort();
    const r = await c.node(script({ baseUrl: `http://127.0.0.1:${port}`, n: 200 }), { timeoutMs: 60_000 });
    c.assert.exit(r, 0, 'emit script');
    c.assert.equal(r.json.closed, 'resolved', 'close()');
    c.assert.equal(r.json.emitThrew, 0, 'emit() threw');
    c.assert.ok(r.json.closeMs < 15_000, `close() took ${r.json.closeMs} ms`);
  });

  const LABEL = 'silent drop: failed deliveries are swallowed and the caller is never told events were lost';

  t.known('failure mode: sink down (connection refused)', LABEL, async (c) => {
    const port = await deadPort();
    await failureMode(c, { baseUrl: `http://127.0.0.1:${port}` });
  }, { timeoutMs: 120_000 });

  t.known('failure mode: events answer 500 on every attempt', LABEL, async (c) => {
    await failureMode(c, { configure: (s) => s.fault({ method: 'POST', path: /\/events$/, status: 500 }) });
  }, { timeoutMs: 120_000 });

  t.known('failure mode: events answer 503 past the retry budget', LABEL, async (c) => {
    await failureMode(c, { configure: (s) => s.fault({ method: 'POST', path: /\/events$/, status: 503 }) });
  }, { timeoutMs: 120_000 });

  t.known('failure mode: events answer 413 batch_too_large', LABEL, async (c) => {
    await failureMode(c, { configure: (s) => s.fault({ method: 'POST', path: /\/events$/, status: 413, body: { error: 'batch_too_large' } }) });
  }, { timeoutMs: 120_000 });

  t.known('failure mode: session open answers 500', LABEL, async (c) => {
    await failureMode(c, { configure: (s) => s.fault({ method: 'POST', path: /^\/v1\/sessions$/, status: 500 }) });
  }, { timeoutMs: 120_000 });
}
