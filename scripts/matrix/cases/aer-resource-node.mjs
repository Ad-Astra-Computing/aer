/**
 * @adastracomputing/aer-resource-node, exercised from the installed package.
 *
 * Every verification runs in a FRESH Node process, so the module-level JWKS
 * cache always starts cold. A warm cache once made a fail-closed JWKS path
 * look fail-open; here nothing can carry over from a previous case. JWKS is
 * served by a per-case sink with a key minted for this run.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintEd25519, signJwt, b64url, b64urlJson, jwkThumbprint, sha256Hex } from '../lib/keys.mjs';
import { deadPort } from '../lib/sink.mjs';

const PKG = '@adastracomputing/aer-resource-node';
export const ISSUER = 'https://aer-api.adastra.computer';
export const AUDIENCE = 'mcp://matrix-resource';
export const JWKS_PATH = '/.well-known/aer-attestation-jwks.json';

/** Claims shaped like the ones AER mints, valid for five minutes. */
export function claims(over = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'agent',
    tenant_id: randomUUID(),
    agent_id: randomUUID(),
    agent_session_id: randomUUID(),
    environment_id: randomUUID(),
    iat: now,
    nbf: now,
    exp: now + 300,
    jti: randomUUID(),
    scp: ['tools:call'],
    ...over,
  };
}

/** Swap the payload of a signed token without re-signing it. */
export function tamperPayload(token, over) {
  const [h, p, s] = token.split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  return `${h}.${b64urlJson({ ...payload, ...over })}.${s}`;
}

/** An RFC 9449 DPoP proof over (method, url) bound to `token`. */
export function dpopProof(holder, { method, url, token, iat = Math.floor(Date.now() / 1000), jti = randomUUID() }) {
  const header = { typ: 'dpop+jwt', alg: 'EdDSA', jwk: { kty: 'OKP', crv: 'Ed25519', x: holder.publicJwk.x } };
  const ath = Buffer.from(sha256Hex(token), 'hex').toString('base64url');
  const input = `${b64urlJson(header)}.${b64urlJson({ htm: method, htu: url, iat, jti, ath })}`;
  return `${input}.${b64url(holder.sign(Buffer.from(input)))}`;
}

export const holderJkt = (holder) => jwkThumbprint(holder.publicJwk);

// Runs in the child: one verifyAttestation call from a cold process.
const VERIFY_SCRIPT = `
import { verifyAttestation, AttestationError } from '@adastracomputing/aer-resource-node';
const input = JSON.parse(process.env.MX_INPUT);
const tokens = { null: null, undefined: undefined, number: 12345, object: {}, array: [], boolean: true };
const token = input.tokenKind ? tokens[input.tokenKind] : input.token;
const runs = input.repeat ?? 1;
const out = [];
for (let i = 0; i < runs; i++) {
  // Take the JWKS down first, then wait: the sink closes a few ms after it
  // answers, and a verify sent inside that window would still reach it.
  if (i > 0 && input.betweenUrl) await fetch(input.betweenUrl, { method: 'POST' }).catch(() => {});
  if (i > 0 && input.pauseMs) await new Promise((r) => setTimeout(r, input.pauseMs));
  try {
    const claims = await verifyAttestation(token, input.opts);
    out.push({ ok: true, agent_id: claims.agent_id });
  } catch (e) {
    out.push({ ok: false, isAttestationError: e instanceof AttestationError, name: e && e.name, code: e && e.code, message: e && e.message });
  }
}
console.log(JSON.stringify(out));
`;

async function verifyCold(c, input) {
  const r = await c.node(VERIFY_SCRIPT, { extraEnv: { MX_INPUT: JSON.stringify(input) }, timeoutMs: 30_000 });
  c.assert.exit(r, 0, 'verify script');
  c.assert.ok(Array.isArray(r.json), `verify script printed no JSON: ${r.stdout.slice(-300)} ${r.stderr.slice(-300)}`);
  return r.json;
}

async function setup(c) {
  const sink = await c.sink();
  const jwksUrl = `${sink.url}${JWKS_PATH}`;
  return { sink, jwksUrl, key: sink.attestationKey };
}

function denyCase(t, title, build, expectCode, expectMessage) {
  t.case(title, async (c) => {
    const s = await setup(c);
    const { token, opts = {}, tokenKind } = await build(s, c);
    const [v] = await verifyCold(c, { token, tokenKind, opts: { audience: AUDIENCE, jwksUrl: s.jwksUrl, ...opts } });
    c.assert.equal(v.ok, false, `${title}: accepted`);
    c.assert.equal(v.isAttestationError, true, `${title}: error type ${v.name}: ${v.message}`);
    c.assert.equal(v.code, expectCode, `${title}: reason`);
    if (expectMessage) c.assert.equal(v.message, expectMessage, `${title}: detail`);
    c.note(`reason ${v.code}${v.message && v.message !== v.code ? ` (${v.message})` : ''}`);
  });
}

export default function register(registry, env) {
  const t = registry.suite('aer-resource-node', PKG);

  t.case('allow: a valid token verifies and returns its claims', async (c) => {
    const s = await setup(c);
    const cl = claims();
    const [v] = await verifyCold(c, { token: signJwt(s.key, cl), opts: { audience: AUDIENCE, jwksUrl: s.jwksUrl } });
    c.assert.equal(v.ok, true, `rejected: ${v.code}`);
    c.assert.equal(v.agent_id, cl.agent_id, 'agent_id');
    c.assert.ok(s.sink.find('GET', JWKS_PATH).length === 1, 'JWKS fetched exactly once');
  });

  // The policy set. Each one runs cold in its own process.
  denyCase(t, 'deny: wrong audience', (s) => ({ token: signJwt(s.key, claims({ aud: 'mcp://someone-else' })) }), 'bad_audience');
  denyCase(t, 'deny: signed by an unknown key under a known kid', (s) => ({ token: signJwt(mintEd25519(s.key.kid), claims()) }), 'bad_signature');
  denyCase(t, 'deny: expired', (s) => {
    const now = Math.floor(Date.now() / 1000);
    return { token: signJwt(s.key, claims({ iat: now - 900, nbf: now - 900, exp: now - 600 })) };
  }, 'expired');
  denyCase(t, 'deny: nbf in the future', (s) => {
    const now = Math.floor(Date.now() / 1000);
    return { token: signJwt(s.key, claims({ nbf: now + 600, exp: now + 900 })) };
  }, 'not_yet_valid');
  denyCase(t, 'deny: alg none', (s) => ({ token: signJwt(s.key, claims(), { alg: 'none' }) }), 'bad_alg');
  denyCase(t, 'deny: HS256 keyed with the public key (algorithm confusion)', (s) => ({ token: signJwt(s.key, claims(), { alg: 'HS256' }) }), 'bad_alg');
  denyCase(t, 'deny: wrong typ', (s) => ({ token: signJwt(s.key, claims(), { typ: 'JWT' }) }), 'bad_typ');
  denyCase(t, 'deny: unknown kid', (s) => ({ token: signJwt(mintEd25519('mx-unknown-kid'), claims()) }), 'unknown_kid');
  denyCase(t, 'deny: wrong issuer', (s) => ({ token: signJwt(s.key, claims({ iss: 'https://evil.example' })) }), 'bad_issuer');
  denyCase(t, 'deny: insufficient scope', (s) => ({ token: signJwt(s.key, claims({ scp: ['tools:list'] })), opts: { requiredScopes: ['tools:call', 'payments:write'] } }), 'insufficient_scope');
  denyCase(t, 'deny: no scp claim when scopes are required', (s) => {
    const cl = claims(); delete cl.scp;
    return { token: signJwt(s.key, cl), opts: { requiredScopes: ['tools:call'] } };
  }, 'insufficient_scope');
  denyCase(t, 'deny: aud as an array', (s) => ({ token: signJwt(s.key, claims({ aud: [AUDIENCE] })) }), 'bad_audience');
  denyCase(t, 'deny: tampered payload', (s) => ({ token: tamperPayload(signJwt(s.key, claims()), { agent_id: randomUUID() }) }), 'bad_signature');
  denyCase(t, 'deny: malformed, one segment', () => ({ token: 'not-a-token' }), 'malformed');
  denyCase(t, 'deny: malformed, header is not JSON', () => ({ token: `${b64url(Buffer.from('{nope'))}.${b64urlJson({})}.sig` }), 'malformed');
  denyCase(t, 'deny: malformed, signature is not base64url', (s) => {
    const [h, p] = signJwt(s.key, claims()).split('.');
    return { token: `${h}.${p}.***not+base64url***` };
  }, 'malformed');
  denyCase(t, 'deny: dpop_required on an unbound token', (s) => ({ token: signJwt(s.key, claims()), opts: { requireDpop: true, dpopProof: 'x', method: 'POST', url: 'https://r.example/mcp' } }), 'dpop_required', 'token_not_bound');
  denyCase(t, 'deny: dpop_required on a bound token with no proof', (s) => {
    const holder = mintEd25519();
    return { token: signJwt(s.key, claims({ cnf: { jkt: holderJkt(holder) } })), opts: { requireDpop: true, method: 'POST', url: 'https://r.example/mcp' } };
  }, 'dpop_required', 'missing_proof');
  denyCase(t, 'deny: dpop_invalid on a proof from another key', (s) => {
    const holder = mintEd25519();
    const token = signJwt(s.key, claims({ cnf: { jkt: holderJkt(holder) } }));
    const url = 'https://r.example/mcp';
    return { token, opts: { requireDpop: true, method: 'POST', url, dpopProof: dpopProof(mintEd25519(), { method: 'POST', url, token }) } };
  }, 'dpop_invalid', 'jkt_mismatch');
  denyCase(t, 'deny: mtls_required on an unbound token', (s) => ({ token: signJwt(s.key, claims()), opts: { requireMtls: true, mtlsThumbprint: 'abc' } }), 'mtls_required', 'token_not_bound');
  denyCase(t, 'deny: mtls_required with no client certificate', (s) => ({ token: signJwt(s.key, claims({ cnf: { 'x5t#S256': 'thumb-A' } })), opts: { requireMtls: true } }), 'mtls_required', 'no_client_cert');
  denyCase(t, 'deny: mtls_invalid on a different certificate', (s) => ({ token: signJwt(s.key, claims({ cnf: { 'x5t#S256': 'thumb-A' } })), opts: { requireMtls: true, mtlsThumbprint: 'thumb-B' } }), 'mtls_invalid', 'thumbprint_mismatch');

  t.case('allow: a DPoP-bound token with a matching proof, and the replay is refused', async (c) => {
    const s = await setup(c);
    const holder = mintEd25519();
    const token = signJwt(s.key, claims({ cnf: { jkt: holderJkt(holder) } }));
    const url = 'https://r.example/mcp';
    const proof = dpopProof(holder, { method: 'POST', url, token });
    const out = await verifyCold(c, { token, repeat: 2, opts: { audience: AUDIENCE, jwksUrl: s.jwksUrl, requireDpop: true, dpopProof: proof, method: 'POST', url } });
    c.assert.equal(out[0].ok, true, `first use rejected: ${out[0].code} ${out[0].message}`);
    c.assert.equal(out[1].code, 'dpop_replay', 'second use of the same proof');
  });

  t.case('allow: an mTLS-bound token with the matching thumbprint', async (c) => {
    const s = await setup(c);
    const [v] = await verifyCold(c, { token: signJwt(s.key, claims({ cnf: { 'x5t#S256': 'thumb-A' } })), opts: { audience: AUDIENCE, jwksUrl: s.jwksUrl, requireMtls: true, mtlsThumbprint: 'thumb-A' } });
    c.assert.equal(v.ok, true, `rejected: ${v.code} ${v.message}`);
  });

  // JWKS failure modes, each cold: the process has never fetched a JWKS.
  // Each mode with the reason it must be reported as: an outage is
  // jwks_unavailable (could not decide), a readable JWKS without the key is
  // unknown_kid.
  const jwksModes = [
    ['unreachable', 'jwks_unavailable', async (s) => ({ jwksUrl: `http://127.0.0.1:${await deadPort()}${JWKS_PATH}` })],
    ['HTTP 503', 'jwks_unavailable', async (s) => { s.sink.fault({ path: /jwks/, status: 503 }); return {}; }],
    ['non-JSON body', 'jwks_unavailable', async (s) => {
      s.sink.route('GET', JWKS_PATH, (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>login</html>'); });
      return {};
    }],
    ['empty key set', 'unknown_kid', async (s) => { s.sink.jwks = { keys: [] }; return {}; }],
    ['keys is not an array', 'jwks_unavailable', async (s) => { s.sink.jwks = { keys: { [s.key.kid]: s.key.publicJwk } }; return {}; }],
    ['connection reset', 'jwks_unavailable', async (s) => { s.sink.fault({ path: /jwks/, destroy: true }); return {}; }],
  ];
  for (const [mode, reason, prep] of jwksModes) {
    t.case(`fail closed cold: JWKS ${mode}`, async (c) => {
      const s = await setup(c);
      const extra = await prep(s);
      const [v] = await verifyCold(c, { token: signJwt(s.key, claims()), opts: { audience: AUDIENCE, jwksUrl: s.jwksUrl, ...extra } });
      c.assert.equal(v.ok, false, `JWKS ${mode}: token accepted`);
      c.assert.equal(v.isAttestationError, true, `JWKS ${mode}: error type ${v.name}: ${v.message}`);
      c.assert.equal(v.code, reason, `JWKS ${mode}: reason`);
    });
  }

  denyCase(t, 'deny: a JWKS key that is not Ed25519', (s) => {
    s.sink.jwks = { keys: [{ ...s.key.publicJwk, kty: 'EC', crv: 'P-256' }] };
    return { token: signJwt(s.key, claims()) };
  }, 'bad_key');

  t.case('fail closed warm: an expired JWKS cache is not trusted once the JWKS is unreachable', async (c) => {
    // max-age=0 makes the first fetch stale at once. The sink then goes away
    // (a POST to /matrix/down closes it) and the same process verifies again.
    const s = await setup(c);
    s.sink.route('GET', JWKS_PATH, (req, res, x) => x.json(200, s.sink.jwks, { 'cache-control': 'max-age=0' }));
    s.sink.route('POST', '/matrix/down', (req, res, x) => { x.json(200, {}); setTimeout(() => s.sink.close(), 10); });
    const out = await verifyCold(c, {
      token: signJwt(s.key, claims()),
      repeat: 2,
      pauseMs: 1100,
      betweenUrl: `${s.sink.url}/matrix/down`,
      opts: { audience: AUDIENCE, jwksUrl: s.jwksUrl },
    });
    c.assert.equal(out[0].ok, true, `first verify rejected: ${out[0].code}`);
    c.note(`second verify after the JWKS went away: ${out[1].ok ? 'ACCEPTED from the stale cache' : `denied ${out[1].code}`}`);
    c.assert.equal(out[1].ok, false, 'a JWKS entry past its max-age was reused after the refetch failed (stale-if-error); AGENTS.md says an unreachable JWKS is a denial');
    c.assert.equal(out[1].code, 'jwks_unavailable', 'reason for the outage');
  });

  for (const kind of ['null', 'undefined', 'number', 'object', 'array', 'boolean']) {
    t.case(`non-string token (${kind}) is AttestationError('malformed')`, async (c) => {
      const s = await setup(c);
      const [v] = await verifyCold(c, { tokenKind: kind, opts: { audience: AUDIENCE, jwksUrl: s.jwksUrl } });
      c.assert.equal(v.ok, false, 'accepted');
      c.assert.equal(v.isAttestationError, true, `threw ${v.name}: ${v.message}`);
      c.assert.equal(v.code, 'malformed', 'code');
    });
  }

  t.case('introspection: inactive is revoked, unreachable fails closed, fail-open is opt-in', async (c) => {
    const s = await setup(c);
    s.sink.route('POST', '/v1/attestations/introspect', (req, res, x) => x.json(200, { active: false, reason: 'session_ended' }));
    const token = signJwt(s.key, claims());
    const base = { audience: AUDIENCE, jwksUrl: s.jwksUrl };
    const [inactive] = await verifyCold(c, { token, opts: { ...base, introspect: { url: `${s.sink.url}/v1/attestations/introspect`, verifierKey: 'aerv_matrix' } } });
    c.assert.equal(inactive.code, 'revoked', 'inactive verdict');
    const dead = `http://127.0.0.1:${await deadPort()}/v1/attestations/introspect`;
    const [closed] = await verifyCold(c, { token, opts: { ...base, introspect: { url: dead, verifierKey: 'aerv_matrix' } } });
    c.assert.equal(closed.code, 'introspection_unavailable', 'unreachable introspection');
    const [open] = await verifyCold(c, { token, opts: { ...base, introspect: { url: dead, verifierKey: 'aerv_matrix', onUnavailable: 'fail-open' } } });
    c.assert.equal(open.ok, true, `fail-open: ${open.code}`);
    const intro = s.sink.find('POST', '/v1/attestations/introspect')[0];
    c.assert.equal(intro?.headers.authorization, 'Bearer aerv_matrix', 'verifier key sent as a bearer');
  });

  t.case('adapters: hono and express deny with 403 and pass a valid token', async (c) => {
    // The adapters need their peers, so this case installs the candidate
    // into its own project next to hono and express.
    const dir = c.tmp('adapters-');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'mx-adapters', private: true, type: 'module' }));
    const inst = await c.run('npm', ['install', '--no-audit', '--no-fund', c.install.spec(PKG), 'hono@4', 'express@5'], { cwd: dir, env: env.npmEnv, timeoutMs: 300_000 });
    c.assert.exit(inst, 0, 'npm install adapters project');
    const s = await setup(c);
    const good = signJwt(s.key, claims());
    const script = `
      import express from 'express';
      import { Hono } from 'hono';
      import { honoAerAttestation } from '@adastracomputing/aer-resource-node/hono';
      import { expressAerAttestation } from '@adastracomputing/aer-resource-node/express';
      const opts = ${JSON.stringify({ audience: AUDIENCE, jwksUrl: s.jwksUrl })};
      const good = ${JSON.stringify(good)};
      const out = {};
      const app = new Hono();
      app.use('/p/*', honoAerAttestation(opts));
      app.get('/p/x', (c) => c.json({ agent: c.get('aerAttestation').agent_id }));
      let r = await app.request('/p/x');
      out.hono_missing = [r.status, await r.json()];
      r = await app.request('/p/x', { headers: { 'x-aer-attestation': 'bad.token.here' } });
      out.hono_bad = [r.status, await r.json()];
      r = await app.request('/p/x', { headers: { 'x-aer-attestation': good } });
      out.hono_good = [r.status, await r.json()];
      const ex = express();
      ex.use('/p', expressAerAttestation(opts));
      ex.get('/p/x', (req, res) => res.json({ agent: req.aerAttestation.agent_id }));
      const srv = await new Promise((res) => { const s = ex.listen(0, '127.0.0.1', () => res(s)); });
      const base = 'http://127.0.0.1:' + srv.address().port;
      r = await fetch(base + '/p/x');
      out.express_missing = [r.status, await r.json()];
      r = await fetch(base + '/p/x', { headers: { 'x-aer-attestation': good } });
      out.express_good = [r.status, await r.json()];
      srv.close();
      console.log(JSON.stringify(out));
    `;
    mkdirSync(join(dir, 's'), { recursive: true });
    writeFileSync(join(dir, 's', 'a.mjs'), script);
    const r = await c.run(process.execPath, [join(dir, 's', 'a.mjs')], { cwd: dir, env: c.env(c.home()), timeoutMs: 30_000 });
    c.assert.exit(r, 0, 'adapter script');
    const o = JSON.parse(r.stdout.trim().split('\n').pop());
    c.assert.equal(o.hono_missing[0], 403, 'hono without a token');
    c.assert.equal(o.hono_missing[1].reason, 'missing_token', 'hono reason');
    c.assert.equal(o.hono_bad[0], 403, 'hono malformed token');
    c.assert.equal(o.hono_good[0], 200, `hono valid token ${JSON.stringify(o.hono_good[1])}`);
    c.assert.equal(o.express_missing[0], 403, 'express without a token');
    c.assert.equal(o.express_good[0], 200, `express valid token ${JSON.stringify(o.express_good[1])}`);
  }, { timeoutMs: 360_000 });
}
