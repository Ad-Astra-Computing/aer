/**
 * A local stand-in for the AER API that records every request.
 *
 * Each case starts its OWN sink on its own ephemeral port and closes it when
 * the case ends. A long-lived shared sink was once reaped mid-run and a case
 * then read the stale log of an earlier one as fresh evidence; a per-case
 * sink makes that impossible.
 *
 * The default routes answer the way the real API does for the paths the
 * client packages call. A case can override any route with `route()` or inject
 * a failure with `fault()`.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mintEd25519, signJwt } from './keys.mjs';

const json = (res, status, body, headers = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
};

/**
 * @param {{ attestationKey?: ReturnType<typeof mintEd25519>, requireAuth?: boolean }} [opts]
 */
export async function startSink(opts = {}) {
  const requests = [];
  const sessions = new Map();
  const overrides = [];
  const faults = [];
  const aers = new Map(); // aer_id -> { bundle, key, anchorEvidence }
  const keys = new Map(); // signing_key_id -> key info object
  const attestationKey = opts.attestationKey ?? mintEd25519('mx-attest');
  let jwks = { keys: [attestationKey.publicJwk] };
  const device = { pendingPolls: 1, deny: false, apiKey: `aer_cli_${randomUUID().replace(/-/g, '')}`, tenantId: randomUUID(), polls: 0 };
  const agents = [{ id: randomUUID(), name: 'matrix-agent', framework_type: 'custom' }];
  const policies = new Map();

  const sink = {
    requests,
    sessions,
    aers,
    keys,
    agents,
    policies,
    device,
    attestationKey,
    get jwks() { return jwks; },
    set jwks(v) { jwks = v; },
    url: '',
    port: 0,
    /** Requests whose method and path match. */
    find(method, pathRe) {
      return requests.filter((r) => (!method || r.method === method) && (typeof pathRe === 'string' ? r.path === pathRe : pathRe.test(r.path)));
    },
    /** Every event body posted to any session, flattened. */
    events() {
      return requests
        .filter((r) => r.method === 'POST' && /^\/v1\/sessions\/[^/]+\/events$/.test(r.path) && Array.isArray(r.json))
        .flatMap((r) => r.json);
    },
    /** The raw text of every request body concatenated, for canary scans. */
    allText() {
      return requests.map((r) => `${r.method} ${r.url}\n${JSON.stringify(r.headers)}\n${r.bodyText}`).join('\n');
    },
    /**
     * Replace a route. handler(req, res, ctx) where ctx = { json, body, match }.
     * Return false from the handler to fall through to the default.
     */
    route(method, pathRe, handler) { overrides.unshift({ method, pathRe, handler }); },
    /**
     * Inject a failure. { method?, path: RegExp, status?, body?, times?,
     * delayMs?, destroy? }. `times` defaults to Infinity.
     */
    fault(f) { faults.push({ times: Infinity, ...f }); },
    clearFaults() { faults.length = 0; },
    close: async () => {},
  };

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyBuf = Buffer.concat(chunks);
    const bodyText = bodyBuf.toString('utf8');
    let parsed;
    try { parsed = bodyText ? JSON.parse(bodyText) : undefined; } catch { parsed = undefined; }
    const u = new URL(req.url, 'http://sink');
    const rec = {
      at: Date.now(),
      method: req.method,
      url: req.url,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      headers: req.headers,
      bodyText,
      json: parsed,
    };
    requests.push(rec);

    for (const f of faults) {
      if (f.times <= 0) continue;
      if (f.method && f.method !== req.method) continue;
      if (!f.path.test(u.pathname)) continue;
      f.times -= 1;
      if (f.delayMs) await new Promise((r) => setTimeout(r, f.delayMs));
      if (f.destroy) { req.socket.destroy(); return; }
      json(res, f.status ?? 500, f.body ?? { error: 'injected_fault' });
      return;
    }

    for (const o of overrides) {
      if (o.method && o.method !== req.method) continue;
      const m = typeof o.pathRe === 'string' ? (u.pathname === o.pathRe ? [u.pathname] : null) : u.pathname.match(o.pathRe);
      if (!m) continue;
      const handled = await o.handler(rec, res, { json: (s, b, h) => json(res, s, b, h), match: m, sink });
      if (handled !== false) return;
    }

    try {
      defaultRoute(rec, res);
    } catch (err) {
      json(res, 500, { error: 'sink_error', message: String(err) });
    }
  });

  const bearer = (rec) => {
    const h = rec.headers['authorization'];
    return typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7) : null;
  };

  function defaultRoute(rec, res) {
    const { method, path } = rec;
    let m;
    if (method === 'GET' && (path === '/healthz' || path === '/readyz')) return json(res, 200, { ok: true });
    if (method === 'GET' && (path === '/.well-known/aer-attestation-jwks.json' || path === '/v1/attestation-keys/jwks')) {
      return json(res, 200, jwks, { 'cache-control': 'max-age=60' });
    }

    if (opts.requireAuth !== false && path.startsWith('/v1/') && !bearer(rec) && !path.startsWith('/v1/cli/device') && !path.startsWith('/v1/keys/') && !/^\/v1\/aers\/[^/]+\/(bundle|anchor-evidence|canonical)$/.test(path)) {
      return json(res, 401, { error: 'unauthorized' });
    }

    if (method === 'POST' && path === '/v1/sessions') {
      const b = rec.json ?? {};
      const ref = typeof b.client_ref === 'string' ? b.client_ref : undefined;
      if (ref) {
        for (const s of sessions.values()) {
          if (s.clientRef === ref && s.status === 'running') {
            const token = `ingest_${randomUUID()}`;
            s.tokens.push(token);
            return json(res, 200, { agent_session_id: s.id, ingest_token: token, status: 'running', reused: true });
          }
        }
      }
      const id = randomUUID();
      const token = `ingest_${randomUUID()}`;
      sessions.set(id, { id, clientRef: ref, status: 'running', tokens: [token], body: b, events: [], apiKey: bearer(rec) });
      return json(res, 201, { agent_session_id: id, ingest_token: token, status: 'running' });
    }
    if ((m = path.match(/^\/v1\/sessions\/([^/]+)\/(events|complete|abort|attestations|otlp\/traces)$/)) && method === 'POST') {
      const s = sessions.get(m[1]);
      if (!s) return json(res, 404, { error: 'session_not_found' });
      if (!s.tokens.includes(bearer(rec))) return json(res, 401, { error: 'invalid_ingest_token' });
      if (m[2] === 'events') {
        if (!Array.isArray(rec.json)) return json(res, 400, { error: 'expected_array' });
        if (s.status !== 'running') return json(res, 409, { error: 'session_not_running' });
        s.events.push(...rec.json);
        return json(res, 202, { accepted: rec.json.length, rejected: 0 });
      }
      if (m[2] === 'complete') {
        if (s.status === 'completed') return json(res, 409, { error: 'session_not_running' });
        s.status = 'completed';
        s.aerId = randomUUID();
        return json(res, 200, { agent_session_id: s.id, status: 'completed', aer_id: s.aerId });
      }
      if (m[2] === 'abort') {
        s.status = 'aborted';
        return json(res, 200, { agent_session_id: s.id, status: 'aborted' });
      }
      if (m[2] === 'attestations') {
        const b = rec.json ?? {};
        const now = Math.floor(Date.now() / 1000);
        const payload = {
          iss: sink.url,
          sub: s.body.agent_id ?? 'agent',
          aud: b.audience,
          iat: now,
          nbf: now,
          exp: now + 300,
          jti: randomUUID(),
          scp: Array.isArray(b.scopes) ? b.scopes : [],
          aer_session_id: s.id,
          tenant_id: s.body.tenant_id,
          agent_id: s.body.agent_id,
        };
        const cnf = {};
        if (b.dpop_jkt) cnf.jkt = b.dpop_jkt;
        if (b.mtls_x5t_s256) cnf['x5t#S256'] = b.mtls_x5t_s256;
        if (Object.keys(cnf).length) payload.cnf = cnf;
        const token = signJwt(attestationKey, payload);
        return json(res, 201, { token, expires_at: new Date((now + 300) * 1000).toISOString(), jti: payload.jti });
      }
      return json(res, 202, { accepted: 0, rejected: 0, dropped_spans: 0, errors: [] });
    }
    if (method === 'POST' && path === '/v1/attestations/introspect') return json(res, 200, { active: true });

    if (method === 'GET' && path === '/v1/agents') return json(res, 200, { agents });
    if (method === 'POST' && path === '/v1/agents') {
      const a = { id: randomUUID(), name: rec.json?.name ?? 'agent', framework_type: rec.json?.framework_type ?? 'custom' };
      agents.push(a);
      return json(res, 201, a);
    }
    if ((m = path.match(/^\/v1\/agents\/([^/]+)\/usage-policy$/)) && method === 'GET') {
      const p = policies.get(decodeURIComponent(m[1]));
      return p ? json(res, 200, p) : json(res, 404, { error: 'policy_not_found' });
    }
    if ((m = path.match(/^\/v1\/agents\/([^/]+)\/baseline$/)) && method === 'GET') return json(res, 404, { error: 'baseline_not_found' });
    if (method === 'GET' && path === '/v1/sessions') {
      return json(res, 200, { sessions: [...sessions.values()].map((s) => ({ agent_session_id: s.id, status: s.status })), next_cursor: null });
    }
    if ((m = path.match(/^\/v1\/sessions\/([^/]+)$/)) && method === 'GET') {
      const s = sessions.get(decodeURIComponent(m[1]));
      return s ? json(res, 200, { agent_session_id: s.id, status: s.status }) : json(res, 404, { error: 'session_not_found' });
    }
    if (method === 'GET' && path === '/v1/findings') return json(res, 200, { findings: [] });
    if (method === 'GET' && path === '/v1/findings/rollup') return json(res, 200, { rollup: [] });
    if (method === 'GET' && path === '/v1/audit') return json(res, 200, { events: [] });
    if (method === 'GET' && path === '/v1/webhooks') return json(res, 200, { webhooks: [] });
    if (method === 'GET' && path === '/v1/aers') return json(res, 200, { aers: [...aers.keys()].map((id) => ({ aer_id: id })), next_cursor: null });

    if ((m = path.match(/^\/v1\/aers\/([^/]+)\/(bundle|anchor-evidence)$/)) && method === 'GET') {
      const a = aers.get(decodeURIComponent(m[1]));
      if (!a) return json(res, 404, { error: 'aer_not_found' });
      if (m[2] === 'bundle') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(typeof a.bundle === 'string' ? a.bundle : JSON.stringify(a.bundle));
        return;
      }
      return a.anchorEvidence ? json(res, 200, a.anchorEvidence) : json(res, 404, { error: 'anchor_evidence_unavailable' });
    }
    if ((m = path.match(/^\/v1\/keys\/([^/]+)$/)) && method === 'GET') {
      const k = keys.get(decodeURIComponent(m[1]));
      return k ? json(res, 200, k) : json(res, 404, { error: 'key_not_found' });
    }

    if (method === 'POST' && path === '/v1/cli/device') {
      return json(res, 200, {
        device_code: `dc_${randomUUID()}`,
        user_code: 'MXAB-CDEF',
        verification_uri: `${sink.url}/cli/activate`,
        verification_uri_complete: `${sink.url}/cli/activate?code=MXAB-CDEF`,
        expires_in: 600,
        interval: 1,
      });
    }
    if (method === 'POST' && path === '/v1/cli/device/token') {
      device.polls += 1;
      if (device.deny) return json(res, 400, { error: 'access_denied' });
      if (device.polls <= device.pendingPolls) return json(res, 400, { error: 'authorization_pending' });
      return json(res, 201, {
        api_key: device.apiKey,
        key_id: randomUUID(),
        tenant_id: device.tenantId,
        role: 'write',
        expires_at: new Date(Date.now() + 90 * 86400_000).toISOString(),
        base_url: sink.url,
      });
    }
    if (method === 'POST' && path === '/v1/cli/logout') return json(res, 200, { revoked: true });

    return json(res, 404, { error: 'not_found', path });
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  sink.port = port;
  sink.url = `http://127.0.0.1:${port}`;
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  let closed = false;
  sink.close = () => new Promise((resolve) => {
    if (closed) return resolve();
    closed = true;
    for (const s of sockets) s.destroy();
    server.close(() => resolve());
  });
  return sink;
}

/** A port that is allocated and then released: nothing listens on it. */
export async function deadPort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}
