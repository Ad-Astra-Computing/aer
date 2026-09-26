/**
 * @adastracomputing/aer-mcp-guard, exercised from the installed package.
 *
 * Each call runs in a fresh Node process against a per-case sink serving the
 * JWKS, so a fail-closed result can never be an artefact of a warm cache.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { mintEd25519, signJwt } from '../lib/keys.mjs';
import { deadPort } from '../lib/sink.mjs';
import { claims, AUDIENCE, JWKS_PATH, holderJkt, dpopProof } from './aer-resource-node.mjs';

const PKG = '@adastracomputing/aer-mcp-guard';

const GUARD_SCRIPT = `
import { guardMcpRequest, MCP_ATTESTATION_ERROR_CODE, statusForReason } from '@adastracomputing/aer-mcp-guard';
const input = JSON.parse(process.env.MX_INPUT);
const headers = Object.fromEntries(Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
const get = (n) => headers[n.toLowerCase()] ?? null;
const r = await guardMcpRequest(get, input.opts, input.rpcId ?? null);
console.log(JSON.stringify({ code: MCP_ATTESTATION_ERROR_CODE, result: r.ok ? { ok: true, agent_id: r.claims.agent_id } : r }));
`;

async function guard(c, input) {
  const r = await c.node(GUARD_SCRIPT, { extraEnv: { MX_INPUT: JSON.stringify(input) }, timeoutMs: 30_000 });
  c.assert.exit(r, 0, 'guard script');
  c.assert.ok(r.json, `guard script printed no JSON: ${r.stdout.slice(-300)} ${r.stderr.slice(-300)}`);
  c.assert.equal(r.json.code, -32001, 'MCP_ATTESTATION_ERROR_CODE');
  return r.json.result;
}

function assertDenial(c, res, status, reason, id = null) {
  c.assert.equal(res.ok, false, `accepted, expected ${reason}`);
  c.assert.equal(res.status, status, `HTTP status for ${reason}`);
  const e = res.jsonRpcError;
  c.assert.equal(e?.jsonrpc, '2.0', 'jsonrpc');
  c.assert.equal(e?.id, id, 'id');
  c.assert.equal(e?.error?.code, -32001, 'error.code');
  c.assert.equal(e?.error?.message, 'attestation required', 'error.message');
  c.assert.equal(e?.error?.data?.reason, reason, 'error.data.reason');
}

export default function register(registry, env) {
  const t = registry.suite('aer-mcp-guard', PKG);
  const base = (s) => ({ audience: AUDIENCE, jwksUrl: `${s.url}${JWKS_PATH}` });

  t.case('allow: a valid X-AER-Attestation passes with its claims', async (c) => {
    const s = await c.sink();
    const cl = claims();
    const res = await guard(c, { headers: { 'X-AER-Attestation': signJwt(s.attestationKey, cl) }, opts: base(s) });
    c.assert.equal(res.ok, true, `denied: ${JSON.stringify(res.jsonRpcError)}`);
    c.assert.equal(res.agent_id, cl.agent_id, 'agent_id');
  });

  const denies = [
    ['no token', () => ({}), 401, 'missing_attestation'],
    ['malformed token', () => ({ headers: { 'x-aer-attestation': 'garbage' } }), 401, 'malformed'],
    ['bad signature', (s) => ({ headers: { 'x-aer-attestation': signJwt(mintEd25519(s.attestationKey.kid), claims()) } }), 401, 'bad_signature'],
    ['expired', (s) => {
      const now = Math.floor(Date.now() / 1000);
      return { headers: { 'x-aer-attestation': signJwt(s.attestationKey, claims({ iat: now - 900, nbf: now - 900, exp: now - 600 })) } };
    }, 401, 'expired'],
    ['wrong audience', (s) => ({ headers: { 'x-aer-attestation': signJwt(s.attestationKey, claims({ aud: 'mcp://other' })) } }), 401, 'bad_audience'],
    ['wrong issuer', (s) => ({ headers: { 'x-aer-attestation': signJwt(s.attestationKey, claims({ iss: 'https://evil.example' })) } }), 401, 'bad_issuer'],
    ['alg none', (s) => ({ headers: { 'x-aer-attestation': signJwt(s.attestationKey, claims(), { alg: 'none' }) } }), 401, 'bad_alg'],
    ['a Bearer token without allowBearer', (s) => ({ headers: { authorization: `Bearer ${signJwt(s.attestationKey, claims())}` } }), 401, 'missing_attestation'],
    ['insufficient scope (403)', (s) => ({ headers: { 'x-aer-attestation': signJwt(s.attestationKey, claims({ scp: [] })) }, opts: { requiredScopes: ['tools:call'] } }), 403, 'insufficient_scope'],
    ['DPoP required and no proof', (s) => {
      const holder = mintEd25519();
      return { headers: { 'x-aer-attestation': signJwt(s.attestationKey, claims({ cnf: { jkt: holderJkt(holder) } })) }, opts: { requireDpop: true, method: 'POST', url: 'https://mcp.example/mcp' } };
    }, 401, 'dpop_required'],
    ['mTLS required and no client certificate', (s) => ({ headers: { 'x-aer-attestation': signJwt(s.attestationKey, claims({ cnf: { 'x5t#S256': 'A' } })) }, opts: { requireMtls: true, resolveMtlsThumbprint: undefined } }), 401, 'mtls_required'],
  ];
  for (const [title, build, status, reason] of denies) {
    t.case(`deny ${status}: ${title}`, async (c) => {
      const s = await c.sink();
      const b = build(s);
      const res = await guard(c, { headers: b.headers ?? {}, opts: { ...base(s), ...(b.opts ?? {}) } });
      assertDenial(c, res, status, reason);
    });
  }

  t.case('deny 403: revoked by introspection', async (c) => {
    const s = await c.sink();
    s.route('POST', '/v1/attestations/introspect', (req, res, x) => x.json(200, { active: false, reason: 'jti_revoked' }));
    const res = await guard(c, {
      headers: { 'x-aer-attestation': signJwt(s.attestationKey, claims()) },
      opts: { ...base(s), introspect: { url: `${s.url}/v1/attestations/introspect`, verifierKey: 'aerv_matrix' } },
    });
    assertDenial(c, res, 403, 'revoked');
  });

  t.case('deny 503: introspection unreachable fails closed', async (c) => {
    const s = await c.sink();
    const res = await guard(c, {
      headers: { 'x-aer-attestation': signJwt(s.attestationKey, claims()) },
      opts: { ...base(s), introspect: { url: `http://127.0.0.1:${await deadPort()}/v1/attestations/introspect`, verifierKey: 'aerv_matrix' } },
    });
    assertDenial(c, res, 503, 'introspection_unavailable');
  });

  t.case('allow: Bearer accepted when allowBearer is set; the rpc id is echoed on a denial', async (c) => {
    const s = await c.sink();
    const ok = await guard(c, { headers: { authorization: `Bearer ${signJwt(s.attestationKey, claims())}` }, opts: { ...base(s), allowBearer: true } });
    c.assert.equal(ok.ok, true, `bearer denied: ${JSON.stringify(ok.jsonRpcError)}`);
    const denied = await guard(c, { headers: {}, opts: base(s), rpcId: 7 });
    assertDenial(c, denied, 401, 'missing_attestation', 7);
  });

  t.case('allow: a DPoP-bound token with a proof read from the DPoP header', async (c) => {
    const s = await c.sink();
    const holder = mintEd25519();
    const token = signJwt(s.attestationKey, claims({ cnf: { jkt: holderJkt(holder) } }));
    const url = 'https://mcp.example/mcp';
    const res = await guard(c, {
      headers: { 'x-aer-attestation': token, dpop: dpopProof(holder, { method: 'POST', url, token }) },
      opts: { ...base(s), requireDpop: true, method: 'POST', url },
    });
    c.assert.equal(res.ok, true, `denied: ${JSON.stringify(res.jsonRpcError)}`);
  });

  for (const [mode, prep] of [
    ['unreachable', async (s) => ({ jwksUrl: `http://127.0.0.1:${await deadPort()}${JWKS_PATH}` })],
    ['HTTP 500', async (s) => { s.fault({ path: /jwks/, status: 500 }); return {}; }],
    ['empty key set', async (s) => { s.jwks = { keys: [] }; return {}; }],
  ]) {
    t.case(`fail closed cold: JWKS ${mode} denies with 401`, async (c) => {
      const s = await c.sink();
      const extra = await prep(s);
      const res = await guard(c, { headers: { 'x-aer-attestation': signJwt(s.attestationKey, claims()) }, opts: { ...base(s), ...extra } });
      c.assert.equal(res.ok, false, `JWKS ${mode}: admitted`);
      c.assert.equal(res.status, 401, 'status');
      c.assert.equal(res.jsonRpcError?.error?.code, -32001, 'error.code');
      c.note(`reason ${res.jsonRpcError?.error?.data?.reason}`);
    });
  }

  t.case('adapters: hono and express return HTTP 401 with the JSON-RPC body and admit a valid token', async (c) => {
    const dir = c.tmp('guard-adapters-');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'mx-guard-adapters', private: true, type: 'module' }));
    // The guard depends on aer-resource-node; install the candidate of both so
    // a local run never picks the published sibling.
    const inst = await c.run('npm', ['install', '--no-audit', '--no-fund', c.install.spec(PKG), c.install.spec('@adastracomputing/aer-resource-node'), 'hono@4', 'express@5'], { cwd: dir, env: env.npmEnv, timeoutMs: 300_000 });
    c.assert.exit(inst, 0, 'npm install adapters project');
    const s = await c.sink();
    const good = signJwt(s.attestationKey, claims());
    const script = `
      import express from 'express';
      import { Hono } from 'hono';
      import { honoMcpGuard } from '@adastracomputing/aer-mcp-guard/hono';
      import { expressMcpGuard } from '@adastracomputing/aer-mcp-guard/express';
      const opts = ${JSON.stringify(base(s))};
      const good = ${JSON.stringify(good)};
      const out = {};
      const app = new Hono();
      app.use('/mcp', honoMcpGuard(opts));
      app.post('/mcp', (c) => c.json({ jsonrpc: '2.0', id: 1, result: { agent: c.get('aerAttestation').agent_id } }));
      let r = await app.request('/mcp', { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
      out.hono_missing = [r.status, await r.json()];
      r = await app.request('/mcp', { method: 'POST', headers: { 'x-aer-attestation': good }, body: '{}' });
      out.hono_good = [r.status, await r.json()];
      const ex = express();
      ex.use(express.json());
      ex.use('/mcp', expressMcpGuard(opts));
      ex.post('/mcp', (req, res) => res.json({ jsonrpc: '2.0', id: req.body.id, result: { agent: req.aerAttestation.agent_id } }));
      const srv = await new Promise((res) => { const s = ex.listen(0, '127.0.0.1', () => res(s)); });
      const base = 'http://127.0.0.1:' + srv.address().port;
      const body = JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/call' });
      r = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      out.express_missing = [r.status, await r.json()];
      r = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-aer-attestation': good }, body });
      out.express_good = [r.status, await r.json()];
      srv.close();
      console.log(JSON.stringify(out));
    `;
    mkdirSync(join(dir, 's'), { recursive: true });
    writeFileSync(join(dir, 's', 'a.mjs'), script);
    const r = await c.run(process.execPath, [join(dir, 's', 'a.mjs')], { cwd: dir, env: c.env(c.home()), timeoutMs: 30_000 });
    c.assert.exit(r, 0, 'adapter script');
    const o = JSON.parse(r.stdout.trim().split('\n').pop());
    c.assert.equal(o.hono_missing[0], 401, 'hono status');
    c.assert.equal(o.hono_missing[1]?.error?.code, -32001, 'hono error.code');
    c.assert.equal(o.hono_missing[1]?.error?.data?.reason, 'missing_attestation', 'hono reason');
    c.assert.equal(o.hono_good[0], 200, `hono valid token ${JSON.stringify(o.hono_good[1])}`);
    c.assert.equal(o.express_missing[0], 401, 'express status');
    c.assert.equal(o.express_missing[1]?.error?.code, -32001, 'express error.code');
    c.assert.equal(o.express_missing[1]?.id, 42, 'express echoes the parsed JSON-RPC id');
    c.assert.equal(o.express_good[0], 200, `express valid token ${JSON.stringify(o.express_good[1])}`);
  }, { timeoutMs: 360_000 });
}
