/**
 * aer-auto-node: the collector loaded the way a customer loads it, through
 * NODE_OPTIONS="--import @adastracomputing/aer-auto-node/register", in a
 * throwaway project whose node_modules is the matrix install.
 *
 * Targets are local servers in the harness process: a plain HTTP one and an
 * HTTPS one whose certificate is minted here, per case, and trusted by the
 * child through NODE_EXTRA_CA_CERTS. Attestation is injected over HTTPS only,
 * so the protected-host cases need the HTTPS target.
 */
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, createPublicKey, createHash, randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canaries, assertNoCanaries } from '../lib/harness.mjs';
import { signJwt, jwkThumbprint } from '../lib/keys.mjs';

const PKG = '@adastracomputing/aer-auto-node';
const REGISTER = `${PKG}/register`;

// ---------------------------------------------------------------------------
// A self-signed certificate, built with a minimal DER encoder so no openssl
// binary or checked-in key is needed. ECDSA P-256, SAN localhost + 127.0.0.1.

function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts.map((p) => Buffer.from(p)));
  return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
};
const seq = (...p) => tlv(0x30, ...p);
const oid = (hex) => tlv(0x06, Buffer.from(hex, 'hex'));
const OID_ECDSA_SHA256 = '2a8648ce3d040302';
const OID_CN = '550403';
const OID_SAN = '551d11';
const OID_BASIC = '551d13';
const utc = (d) => tlv(0x17, Buffer.from(`${d.toISOString().slice(2, 19).replace(/[-:T]/g, '')}Z`));

export function mintTlsCert() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const name = seq(tlv(0x31, seq(oid(OID_CN), tlv(0x0c, Buffer.from('localhost')))));
  const sigAlg = seq(oid(OID_ECDSA_SHA256));
  const serial = randomBytes(8);
  serial[0] &= 0x7f;
  const now = Date.now();
  const san = seq(tlv(0x82, Buffer.from('localhost')), tlv(0x87, Buffer.from([127, 0, 0, 1])));
  const exts = tlv(0xa3, seq(
    seq(oid(OID_BASIC), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq(tlv(0x01, Buffer.from([0xff]))))),
    seq(oid(OID_SAN), tlv(0x04, san)),
  ));
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    sigAlg,
    name,
    seq(utc(new Date(now - 3600_000)), utc(new Date(now + 86400_000))),
    name,
    spki,
    exts,
  );
  const sig = cryptoSign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const der = seq(tbs, sigAlg, tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

// ---------------------------------------------------------------------------
// Targets and the workload project.

async function startTarget(c, { tls } = {}) {
  const hits = [];
  const handler = async (req, res) => {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    hits.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('target-ok');
  };
  let server;
  let certFile;
  if (tls) {
    const { cert, key } = mintTlsCert();
    certFile = join(c.tmp('tls-'), 'ca.pem');
    writeFileSync(certFile, cert);
    server = createHttpsServer({ cert, key }, handler);
  } else {
    server = createServer(handler);
  }
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.on('secureConnection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  c.cleanup(() => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }));
  return { hits, port, certFile, url: tls ? `https://localhost:${port}` : `http://127.0.0.1:${port}` };
}

const IDS = () => ({ tenant_id: randomUUID(), agent_id: randomUUID(), env_id: randomUUID() });

/**
 * Run `workload` (module source) under the register hook, in a fresh project
 * whose node_modules is the install. `config` is written as aer.config.json.
 */
async function runWorkload(c, { config, workload, env = {}, input, timeoutMs = 60_000 }) {
  const proj = c.tmp('proj-');
  symlinkSync(join(c.install.dir, 'node_modules'), join(proj, 'node_modules'), 'dir');
  writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'mx-workload', version: '1.0.0', private: true, type: 'module' }));
  if (config) writeFileSync(join(proj, 'aer.config.json'), JSON.stringify({ schema: 'aer.config.v1', ...config }, null, 2));
  writeFileSync(join(proj, 'workload.mjs'), workload);
  const home = c.home();
  const r = await c.run(process.execPath, ['workload.mjs'], {
    cwd: proj,
    env: c.env(home, { NODE_OPTIONS: `--import ${REGISTER}`, AER_API_KEY: 'aer_matrix_test_key', ...env }),
    input,
    timeoutMs,
  });
  const last = r.stdout.trim().split('\n').pop();
  try { r.json = JSON.parse(last); } catch { r.json = undefined; }
  r.proj = proj;
  return r;
}

/** A workload that fetches `url` once and reports status plus egress header. */
const fetchOnce = (url, init = {}) => `
  const r = await fetch(${JSON.stringify(url)}, ${JSON.stringify(init)});
  const body = await r.text();
  console.log(JSON.stringify({ status: r.status, egress: r.headers.get('x-aer-egress'), body: body.slice(0, 200) }));
`;

const byType = (events, t) => events.filter((e) => e?.event_type === t);

function decodeJwt(token) {
  const [h, p, s] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(p, 'base64url').toString('utf8')),
    input: `${h}.${p}`,
    sig: Buffer.from(s ?? '', 'base64url'),
  };
}

function assertCompletedOnce(c, sink) {
  const opens = sink.find('POST', '/v1/sessions');
  c.assert.equal(opens.length, 1, 'session opens');
  const completes = sink.find('POST', /^\/v1\/sessions\/[^/]+\/complete$/);
  c.assert.equal(completes.length, 1, '/complete calls');
  const s = [...sink.sessions.values()][0];
  c.assert.equal(s.status, 'completed', 'session status at the sink');
}

const protectedConfig = (sink, target, resource) => ({
  ...IDS(),
  base_url: sink.url,
  protected_resources: [{ host: 'localhost', audience: 'mcp://matrix-protected', ...resource }],
});

// ---------------------------------------------------------------------------

export default function register(registry) {
  const t = registry.suite('aer-auto-node', PKG);

  t.case('register: fetch, http and exec captured; /complete on clean exit', async (c) => {
    const sink = await c.sink();
    const target = await startTarget(c);
    const ids = IDS();
    const r = await runWorkload(c, {
      config: { ...ids, base_url: sink.url },
      workload: `
        import cp from 'node:child_process';
        import http from 'node:http';
        const f = await fetch(${JSON.stringify(`${target.url}/a`)});
        await f.text();
        await new Promise((res, rej) => {
          const req = http.request(${JSON.stringify(`${target.url}/b`)}, (resp) => { resp.resume(); resp.on('end', res); });
          req.on('error', rej); req.end();
        });
        await new Promise((res) => cp.execFile(process.execPath, ['-e', '0'], () => res()));
        await new Promise((res) => cp.exec('node -e 0', () => res()));
        console.log(JSON.stringify({ ok: true }));
      `,
    });
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(r.json?.ok, true, 'workload output');
    const open = sink.find('POST', '/v1/sessions')[0];
    c.assert.ok(open, 'no session was opened');
    c.assert.equal(open.json.tenant_id, ids.tenant_id, 'tenant_id');
    c.assert.equal(open.json.agent_id, ids.agent_id, 'agent_id');
    c.assert.equal(open.json.environment_id, ids.env_id, 'environment_id');
    c.assert.equal(open.headers.authorization, 'Bearer aer_matrix_test_key', 'tenant key header');
    const ev = sink.events();
    for (const e of ev) c.assert.equal(e.source_type, 'wrapper', `source_type of ${e.event_type}`);
    c.assert.ok(byType(ev, 'session.started').length === 1, 'session.started missing');
    c.assert.ok(byType(ev, 'collector.report').length >= 1, 'collector.report missing');
    const reqs = byType(ev, 'http.requested');
    c.assert.ok(reqs.length >= 2, `expected fetch and http.request captured, got ${reqs.length} http.requested`);
    c.assert.ok(reqs.every((e) => String(e.payload.host).startsWith('127.0.0.1')), `hosts: ${JSON.stringify(reqs.map((e) => e.payload.host))}`);
    c.assert.ok(byType(ev, 'http.completed').some((e) => e.payload.status === 200), 'http.completed with status 200 missing');
    const execs = byType(ev, 'process.exec');
    c.assert.equal(execs.length, 2, 'process.exec events');
    for (const e of execs) c.assert.equal(e.payload.command, 'node', 'process.exec command');
    c.assert.ok(byType(ev, 'process.exit').length >= 2, 'process.exit events missing');
    assertCompletedOnce(c, sink);
    c.note(`${ev.length} events: ${[...new Set(ev.map((e) => e.event_type))].join(', ')}`);
  });

  t.case('bodies-off: canaries in query, body, headers, args, output and files never reach the sink', async (c) => {
    const sink = await c.sink();
    const target = await startTarget(c);
    const k = canaries('AUTO');
    const r = await runWorkload(c, {
      config: { ...IDS(), base_url: sink.url },
      env: { MX: JSON.stringify(k) },
      workload: `
        import cp from 'node:child_process';
        import fs from 'node:fs';
        const k = JSON.parse(process.env.MX);
        const f = await fetch(${JSON.stringify(target.url)} + '/q?token=' + k.query + '&p=' + k.prompt, {
          method: 'POST', body: JSON.stringify({ prompt: k.prompt, secret: k.secret }),
          headers: { 'x-api-key': k.secret, 'content-type': 'application/json' } });
        await f.text();
        const out = await new Promise((res) => cp.execFile(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', k.result, k.args], (e, o) => res(o)));
        await new Promise((res) => cp.exec('SECRET_VAR=' + k.secret + ' node -e 0 ' + k.args, () => res()));
        const sp = cp.spawn(process.execPath, ['-e', '0', '--', k.args]);
        await new Promise((res) => sp.on('exit', res));
        fs.writeFileSync('canary.txt', k.file);
        const back = fs.readFileSync('canary.txt', 'utf8');
        console.log(JSON.stringify({ ok: out === k.result && back === k.file }));
      `,
    });
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(r.json?.ok, true, 'workload saw its own data');
    c.assert.ok(sink.events().length > 0, 'no events reached the sink');
    // The target must have received the real body: capture never alters traffic.
    c.assert.includes(target.hits[0]?.body, k.prompt, 'request body at the target');
    assertNoCanaries(sink.allText(), k);
    c.assert.ok(!sink.events().some((e) => /^file\./.test(e.event_type)), 'fs produced an event; README says fs is not instrumented');
    const execs = byType(sink.events(), 'process.exec');
    c.assert.equal(execs.length, 3, 'process.exec events');
    for (const e of execs) {
      c.assert.equal(e.payload.command, 'node', 'command reduced to the executable name');
      c.assert.match(e.payload.args_redacted ?? '', /^<\d+ args redacted>$/, 'args redacted');
    }
    const q = byType(sink.events(), 'http.requested')[0];
    c.assert.match(q.payload.path_redacted ?? '', /\?<redacted>$/, 'query string marker');
  });

  t.case('redaction: a URL is recorded as its host only (README and AGENTS.md claim)', async (c) => {
    const sink = await c.sink();
    const target = await startTarget(c);
    const k = canaries('AUTOPATH');
    const r = await runWorkload(c, {
      config: { ...IDS(), base_url: sink.url },
      workload: fetchOnce(`${target.url}/users/${k.path}/profile`),
    });
    c.assert.exit(r, 0, 'workload');
    const reqs = byType(sink.events(), 'http.requested');
    c.assert.ok(reqs.length === 1, `http.requested count ${reqs.length}`);
    c.assert.excludes(sink.allText(), k.path,
      `URL path segment reached the sink (payload ${JSON.stringify(reqs[0].payload)}); ` +
      'the README says "URLs are reduced to their host" and AGENTS.md says "a URL its host"');
  });

  t.case('collector version declared at session open equals the package version', async (c) => {
    const sink = await c.sink();
    const target = await startTarget(c);
    const r = await runWorkload(c, { config: { ...IDS(), base_url: sink.url }, workload: fetchOnce(`${target.url}/`) });
    c.assert.exit(r, 0, 'workload');
    const want = c.install.version(PKG);
    const open = sink.find('POST', '/v1/sessions')[0];
    const report = byType(sink.events(), 'collector.report')[0];
    const got = { session_open: open?.json?.collector?.version, collector_report: report?.payload?.version };
    c.assert.ok(got.session_open === want && got.collector_report === want,
      `package is ${want}, collector declares ${JSON.stringify(got)}`);
  });

  t.case('config: env overrides beat aer.config.json', async (c) => {
    const sink = await c.sink();
    const target = await startTarget(c);
    const override = randomUUID();
    const r = await runWorkload(c, {
      config: { ...IDS(), base_url: 'http://127.0.0.1:1' },
      env: { AER_AGENT_ID: override, AER_BASE_URL: sink.url },
      workload: fetchOnce(`${target.url}/`),
    });
    c.assert.exit(r, 0, 'workload');
    const open = sink.find('POST', '/v1/sessions')[0];
    c.assert.ok(open, 'AER_BASE_URL did not override base_url');
    c.assert.equal(open.json.agent_id, override, 'AER_AGENT_ID override');
  });

  t.case('unconfigured and AER_DISABLE=1: host runs, nothing is sent', async (c) => {
    const sink = await c.sink();
    const target = await startTarget(c);
    const noKey = await runWorkload(c, {
      config: { ...IDS(), base_url: sink.url },
      env: { AER_API_KEY: undefined },
      workload: fetchOnce(`${target.url}/`),
    });
    c.assert.exit(noKey, 0, 'workload without AER_API_KEY');
    c.assert.equal(noKey.json?.status, 200, 'workload fetch without a key');
    c.assert.includes(noKey.stderr, 'not started', 'unconfigured warning');
    const disabled = await runWorkload(c, {
      config: { ...IDS(), base_url: sink.url },
      env: { AER_DISABLE: '1' },
      workload: fetchOnce(`${target.url}/`),
    });
    c.assert.exit(disabled, 0, 'workload with AER_DISABLE=1');
    c.assert.equal(disabled.json?.status, 200, 'workload fetch with AER_DISABLE=1');
    c.assert.equal(sink.requests.length, 0, 'requests reached the sink');
  });

  t.case('sink down: the host exits 0 on time with its own result intact', async (c) => {
    const target = await startTarget(c);
    const r = await runWorkload(c, {
      config: { ...IDS(), base_url: 'http://127.0.0.1:9' },
      workload: `
        import cp from 'node:child_process';
        ${fetchOnce(`${target.url}/`)}
        await new Promise((res) => cp.execFile(process.execPath, ['-e', '0'], () => res()));
      `,
      timeoutMs: 30_000,
    });
    c.assert.ok(!r.timedOut, 'workload hung with the AER API unreachable');
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(JSON.parse(r.stdout.trim().split('\n')[0]).status, 200, 'host fetch result');
    c.assert.ok(r.ms < 20_000, `workload took ${r.ms} ms`);
    c.note(`exit after ${r.ms} ms`);
  });

  t.case('crash: an uncaught exception aborts the session and keeps the crash exit', async (c) => {
    const sink = await c.sink();
    const target = await startTarget(c);
    const r = await runWorkload(c, {
      config: { ...IDS(), base_url: sink.url },
      workload: `${fetchOnce(`${target.url}/`)}\nsetTimeout(() => { throw new Error('mx-crash'); }, 50);`,
    });
    c.assert.ok(r.code !== 0, `crash exit code was ${r.code}`);
    c.assert.includes(r.stderr, 'mx-crash', 'original error on stderr');
    const aborts = sink.find('POST', /\/abort$/);
    c.assert.equal(sink.find('POST', /\/complete$/).length, 0, '/complete after a crash');
    if (aborts.length === 0) c.note('no /abort reached the sink before the crash exit (abort is best-effort per bootstrap.ts)');
  });

  t.case('attestation: injected on the protected HTTPS host, signed by the sink key, absent elsewhere', async (c) => {
    const sink = await c.sink();
    const prot = await startTarget(c, { tls: true });
    const plain = await startTarget(c);
    const r = await runWorkload(c, {
      config: protectedConfig(sink, prot, {}),
      env: { NODE_EXTRA_CA_CERTS: prot.certFile },
      workload: `
        ${fetchOnce(`${prot.url}/tools`)}
        const p = await fetch(${JSON.stringify(`${plain.url}/other`)}); await p.text();
      `,
    });
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(r.json?.status ?? JSON.parse(r.stdout.trim().split('\n')[0]).status, 200, 'protected fetch');
    const tok = prot.hits[0]?.headers['x-aer-attestation'];
    c.assert.ok(tok, 'no X-AER-Attestation at the protected host');
    const j = decodeJwt(tok);
    c.assert.ok(cryptoVerify(null, Buffer.from(j.input), sink.attestationKey.publicKey, j.sig), 'token signature does not verify with the sink key');
    c.assert.equal(j.payload.aud, 'mcp://matrix-protected', 'token audience');
    const sid = [...sink.sessions.keys()][0];
    c.assert.equal(j.payload.aer_session_id, sid, 'token session');
    c.assert.equal(plain.hits[0]?.headers['x-aer-attestation'], undefined, 'token leaked to an unprotected host');
    assertCompletedOnce(c, sink);
  });

  t.case('attestation: never injected over plain http, even for a listed host', async (c) => {
    const sink = await c.sink();
    const plain = await startTarget(c);
    const r = await runWorkload(c, {
      config: { ...IDS(), base_url: sink.url, protected_resources: [{ host: '127.0.0.1', audience: 'mcp://plain' }] },
      workload: fetchOnce(`${plain.url}/`),
    });
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(plain.hits[0]?.headers['x-aer-attestation'], undefined, 'token sent over plain http');
    // The process strategy prewarms a token for every listed resource at
    // startup (config carries no scheme), so a mint is expected; the token
    // must still never be sent over plain http.
    c.note(`${sink.find('POST', /\/attestations$/).length} prewarm mint(s); none sent`);
  });

  t.case('attestation: a caller-supplied header is never overwritten', async (c) => {
    const sink = await c.sink();
    const prot = await startTarget(c, { tls: true });
    const r = await runWorkload(c, {
      config: protectedConfig(sink, prot, {}),
      env: { NODE_EXTRA_CA_CERTS: prot.certFile },
      workload: fetchOnce(`${prot.url}/`, { headers: { 'x-aer-attestation': 'caller-token' } }),
    });
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(prot.hits[0]?.headers['x-aer-attestation'], 'caller-token', 'header at the target');
  });

  const mintFails = (sink) => sink.fault({ method: 'POST', path: /\/attestations$/, status: 503 });

  t.case('enforcement off: mint failure never blocks, no egress event', async (c) => {
    const sink = await c.sink();
    mintFails(sink);
    const prot = await startTarget(c, { tls: true });
    const r = await runWorkload(c, {
      config: protectedConfig(sink, prot, { enforcement: 'off', on_unavailable: 'fail_closed' }),
      env: { NODE_EXTRA_CA_CERTS: prot.certFile },
      workload: fetchOnce(`${prot.url}/`),
    });
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(r.json?.status, 200, 'status');
    c.assert.equal(prot.hits.length, 1, 'target hits');
    c.assert.equal(prot.hits[0].headers['x-aer-attestation'], undefined, 'header without a token');
    const eg = sink.events().filter((e) => /^egress\./.test(e.event_type));
    c.assert.equal(eg.length, 0, 'egress events in off mode');
  });

  t.case('enforcement report: mint failure lets the request out and records would_block', async (c) => {
    const sink = await c.sink();
    mintFails(sink);
    const prot = await startTarget(c, { tls: true });
    const r = await runWorkload(c, {
      config: protectedConfig(sink, prot, { enforcement: 'report' }),
      env: { NODE_EXTRA_CA_CERTS: prot.certFile },
      workload: fetchOnce(`${prot.url}/`),
    });
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(r.json?.status, 200, 'status');
    c.assert.equal(prot.hits.length, 1, 'target hits');
    const wb = byType(sink.events(), 'egress.would_block');
    c.assert.ok(wb.length === 1 && wb[0].payload.reason === 'unavailable' && wb[0].payload.mode === 'report', `egress.would_block: ${JSON.stringify(wb)}`);
  });

  t.case('enforcement block + fail_closed: mint failure denies, the target sees nothing', async (c) => {
    const sink = await c.sink();
    mintFails(sink);
    const prot = await startTarget(c, { tls: true });
    const k = canaries('EGRESS');
    const r = await runWorkload(c, {
      config: protectedConfig(sink, prot, { enforcement: 'block', on_unavailable: 'fail_closed' }),
      env: { NODE_EXTRA_CA_CERTS: prot.certFile },
      workload: fetchOnce(`${prot.url}/`, { method: 'POST', body: k.secret }),
    });
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(r.json?.status, 403, 'synthetic status');
    c.assert.equal(r.json?.egress, 'blocked', 'x-aer-egress header');
    c.assert.equal(prot.hits.length, 0, 'the blocked request reached the target');
    const b = byType(sink.events(), 'egress.blocked');
    c.assert.ok(b.length === 1 && b[0].payload.reason === 'unavailable', `egress.blocked: ${JSON.stringify(b)}`);
    assertNoCanaries(sink.allText(), k);
  });

  t.case('enforcement block + fail_open: mint failure lets it out without a token', async (c) => {
    const sink = await c.sink();
    mintFails(sink);
    const prot = await startTarget(c, { tls: true });
    const r = await runWorkload(c, {
      config: protectedConfig(sink, prot, { enforcement: 'block', on_unavailable: 'fail_open' }),
      env: { NODE_EXTRA_CA_CERTS: prot.certFile },
      workload: fetchOnce(`${prot.url}/`),
    });
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(r.json?.status, 200, 'status');
    c.assert.equal(prot.hits.length, 1, 'target hits');
    c.assert.equal(prot.hits[0].headers['x-aer-attestation'], undefined, 'header');
    const wb = byType(sink.events(), 'egress.would_block');
    c.assert.ok(wb.length === 1 && wb[0].payload.reason === 'unavailable' && wb[0].payload.mode === 'block', `egress.would_block: ${JSON.stringify(wb)}`);
  });

  t.case('enforcement block: a token missing a required scope denies even with fail_open', async (c) => {
    const sink = await c.sink();
    // The server downscopes: whatever is asked for, grant no scopes.
    sink.route('POST', /^\/v1\/sessions\/([^/]+)\/attestations$/, (rec, res, { json, match }) => {
      const now = Math.floor(Date.now() / 1000);
      const token = signJwt(sink.attestationKey, { aud: rec.json?.audience, iat: now, nbf: now, exp: now + 300, jti: randomUUID(), scp: [], aer_session_id: match[1] });
      json(201, { token, expires_at: new Date((now + 300) * 1000).toISOString() });
    });
    const prot = await startTarget(c, { tls: true });
    const r = await runWorkload(c, {
      config: protectedConfig(sink, prot, { enforcement: 'block', on_unavailable: 'fail_open', scopes: ['tools:write'] }),
      env: { NODE_EXTRA_CA_CERTS: prot.certFile },
      workload: fetchOnce(`${prot.url}/`),
    });
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(r.json?.status, 403, 'status');
    c.assert.equal(prot.hits.length, 0, 'target hits');
    const mint = sink.find('POST', /\/attestations$/)[0];
    c.assert.ok(mint?.json?.scopes?.includes('tools:write'), `mint request scopes: ${JSON.stringify(mint?.json)}`);
    const b = byType(sink.events(), 'egress.blocked');
    c.assert.ok(b.length === 1 && b[0].payload.reason === 'insufficient_scope', `egress.blocked: ${JSON.stringify(b)}`);
  });

  t.case('enforcement block: a valid token with the scope is allowed and attached', async (c) => {
    const sink = await c.sink();
    const prot = await startTarget(c, { tls: true });
    const r = await runWorkload(c, {
      config: protectedConfig(sink, prot, { enforcement: 'block', scopes: ['tools:write'] }),
      env: { NODE_EXTRA_CA_CERTS: prot.certFile },
      workload: fetchOnce(`${prot.url}/`),
    });
    c.assert.exit(r, 0, 'workload');
    c.assert.equal(r.json?.status, 200, 'status');
    const tok = prot.hits[0]?.headers['x-aer-attestation'];
    c.assert.ok(tok, 'token attached');
    c.assert.ok(decodeJwt(tok).payload.scp.includes('tools:write'), 'token scopes');
    c.assert.equal(sink.events().filter((e) => /^egress\./.test(e.event_type)).length, 0, 'egress events on an allowed request');
  });

  t.case('DPoP: proof attached, signed by its jwk, bound to the token cnf.jkt', async (c) => {
    const sink = await c.sink();
    const prot = await startTarget(c, { tls: true });
    const url = `${prot.url}/tools/call?x=1`;
    const r = await runWorkload(c, {
      config: protectedConfig(sink, prot, { dpop: true }),
      env: { NODE_EXTRA_CA_CERTS: prot.certFile },
      workload: fetchOnce(url, { method: 'POST', body: '{}' }),
    });
    c.assert.exit(r, 0, 'workload');
    const hit = prot.hits[0];
    c.assert.ok(hit, 'protected request did not arrive');
    const tok = hit.headers['x-aer-attestation'];
    const proof = hit.headers['dpop'];
    c.assert.ok(tok && proof, `token ${Boolean(tok)}, DPoP ${Boolean(proof)}`);
    const mint = sink.find('POST', /\/attestations$/)[0];
    c.assert.ok(typeof mint?.json?.dpop_jkt === 'string', 'mint request carried no dpop_jkt');
    const t0 = decodeJwt(tok);
    c.assert.equal(t0.payload.cnf?.jkt, mint.json.dpop_jkt, 'token cnf.jkt');
    const p = decodeJwt(proof);
    c.assert.equal(p.header.typ, 'dpop+jwt', 'proof typ');
    c.assert.equal(p.header.alg, 'EdDSA', 'proof alg');
    c.assert.equal(jwkThumbprint(p.header.jwk), t0.payload.cnf.jkt, 'proof jwk thumbprint vs cnf.jkt');
    const pub = createPublicKey({ key: p.header.jwk, format: 'jwk' });
    c.assert.ok(cryptoVerify(null, Buffer.from(p.input), pub, p.sig), 'proof signature does not verify');
    c.assert.equal(p.payload.htm, 'POST', 'htm');
    c.assert.equal(p.payload.htu, `https://localhost:${prot.port}/tools/call`, 'htu');
    c.assert.equal(p.payload.ath, createHash('sha256').update(tok).digest('base64url'), 'ath');
    c.assert.ok(Math.abs(p.payload.iat - Date.now() / 1000) < 120, 'iat');
  });

  t.case('no DPoP header when the resource does not opt in', async (c) => {
    const sink = await c.sink();
    const prot = await startTarget(c, { tls: true });
    const r = await runWorkload(c, {
      config: protectedConfig(sink, prot, {}),
      env: { NODE_EXTRA_CA_CERTS: prot.certFile },
      workload: fetchOnce(`${prot.url}/`),
    });
    c.assert.exit(r, 0, 'workload');
    c.assert.ok(prot.hits[0]?.headers['x-aer-attestation'], 'token');
    c.assert.equal(prot.hits[0]?.headers['dpop'], undefined, 'DPoP header');
    c.assert.equal(sink.find('POST', /\/attestations$/)[0]?.json?.dpop_jkt, undefined, 'dpop_jkt at mint');
  });
}
