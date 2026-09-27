/**
 * The one place the matrix reaches production, and only with --live.
 *
 * A positive verdict from `aer verify` needs a record signed by a key in the
 * CLI's pinned production trust root. The CLI has no way to swap that root,
 * on purpose: an override honoured by a published build is a way to make a
 * forged bundle print "verified". So the positive path is exercised against
 * the real thing: the newest public demo record, fetched from api.aer.run
 * and checked by the installed CLI exactly as a customer would check it.
 * Every request is a public, unauthenticated read; no credential is sent.
 *
 * Off by default, so `pnpm matrix` stays hermetic. The library-level
 * positive verdicts (a minted key passed as a pinned key) are covered in the
 * aer-verify suite without any network.
 */
import { withNetwork } from '../lib/proc.mjs';

const API = 'https://api.aer.run';

async function demoAerId() {
  const res = await fetch(`${API}/v1/demo/latest`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`GET /v1/demo/latest answered ${res.status}`);
  const body = await res.json();
  if (typeof body.aer_id !== 'string') throw new Error('the demo record has no aer_id');
  return body.aer_id;
}

export default function register(registry, env) {
  const t = registry.suite('live', 'api.aer.run');
  if (!env.opts.live) {
    t.skip('live production verify', 'runs only with --live');
    return;
  }

  // Production, but nothing secret: a clean env with only the base URL.
  const liveEnv = (c) => {
    const e = withNetwork(c.env(c.home(), { AER_BASE_URL: API }));
    for (const k of Object.keys(e)) if (k.startsWith('AER_') && k !== 'AER_BASE_URL' && k !== 'AER_COMMITMENT_KEY') delete e[k];
    return e;
  };

  t.case('aer verify: the public demo record verifies against the pinned production keys', async (c) => {
    const id = await demoAerId();
    const r = await c.run(`${c.install.binDir}/aer`, ['verify', id], { env: liveEnv(c), allowProduction: true, timeoutMs: 60_000 });
    c.assert.exit(r, 0, 'aer verify');
    const res = JSON.parse(r.stdout);
    c.assert.equal(res.hash_match, true, 'hash_match');
    c.assert.equal(res.signature_valid, true, 'signature_valid');
    c.assert.equal(res.verified, true, 'verified');
    c.note(`${id}: anchor_status ${res.anchor_status}, anchored ${res.anchored}`);
  });

  t.case('aer commitments verify: the demo bundle signature verifies; a random key opens nothing', async (c) => {
    const id = await demoAerId();
    const dir = c.tmp();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${dir}/requests.json`, '[]');
    const key = (await import('node:crypto')).randomBytes(32).toString('hex');
    const e = { ...liveEnv(c), AER_COMMITMENT_KEY: key };
    const r = await c.run(`${c.install.binDir}/aer`, ['commitments', 'verify', '--aer', id, '--requests', `${dir}/requests.json`], { env: e, allowProduction: true, timeoutMs: 60_000 });
    const res = JSON.parse(r.stdout);
    c.assert.equal(res.bundle_verified, true, 'bundle_verified against the production trust root');
    c.assert.equal(res.bundle_signature.anchored, false, 'anchored without evidence');
    c.assert.equal(res.key_kid_matches_bundle, false, 'a random key matched the bundle');
    c.assert.equal(res.matched, 0, 'matched');
    c.assert.excludes(r.stdout + r.stderr, key, 'the commitment key was printed');
  });
}
