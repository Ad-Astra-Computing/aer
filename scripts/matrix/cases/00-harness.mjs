/**
 * The matrix's own safety net. These run first, whatever --only says, and a
 * failure here stops the run before any other suite starts.
 *
 * The primary guard is the blackhole proxy: it covers every Node process a
 * case starts, including grandchildren (a workload's own spawns, a package
 * script) that build their own environment. The refusal in run() only sees
 * the environment the runner hands to its direct child, so it is a second
 * line, not the first. The proxy needs a Node whose NODE_USE_ENV_PROXY covers
 * fetch and node:http(s); run.mjs refuses to start on anything older.
 */
import { run, ProductionTargetError, PRODUCTION_HOST } from '../lib/proc.mjs';

export default function register(registry) {
  const t = registry.suite('harness', 'scripts/matrix');

  t.case('the runner holds no AER_* variable a spawn could inherit', (c) => {
    const left = Object.keys(process.env).filter((k) => k.startsWith('AER_'));
    c.assert.equal(left.length, 0, `AER_* left in the runner env: ${left.join(', ')}`);
  });

  t.case(`a child env naming ${PRODUCTION_HOST} is refused before it starts`, async (c) => {
    for (const env of [
      c.env(c.home(), { AER_BASE_URL: `https://${PRODUCTION_HOST}` }),
      c.env(c.home(), { SOMETHING_ELSE: `see https://${PRODUCTION_HOST}/v1` }),
    ]) {
      let refused = null;
      try { await run(process.execPath, ['-e', '0'], { env }); } catch (err) { refused = err; }
      c.assert.ok(refused instanceof ProductionTargetError, `spawn was not refused: ${refused}`);
    }
    let refused = null;
    try { await run(process.execPath, ['-e', '0', `https://${PRODUCTION_HOST}`], { env: c.env(c.home()) }); } catch (err) { refused = err; }
    c.assert.ok(refused instanceof ProductionTargetError, 'an argument naming the production host was not refused');
  });

  t.case('a case process cannot reach a non-loopback host', async (c) => {
    // Without the blackhole proxy this fetch would leave the machine. A
    // client falling back to its built-in production base URL takes the same
    // path, so this is what stops a case that forgot AER_BASE_URL.
    const r = await c.node(`
      const out = {};
      try { const res = await fetch('https://example.com/', { signal: AbortSignal.timeout(10000) }); out.status = res.status; }
      catch (err) { out.error = String(err?.cause?.code ?? err?.cause?.message ?? err?.message ?? err); }
      console.log(JSON.stringify(out));
    `);
    c.assert.exit(r, 0, 'probe');
    c.assert.ok(r.json && r.json.error && r.json.status === undefined, `a case process reached the network: ${r.stdout.trim()}`);
    c.note(`outbound fetch failed as intended: ${r.json.error}`);
  });

  t.case('the sink refuses a session open the real API would refuse', async (c) => {
    // A lax sink once answered 201 to opens with no agent_version, which the
    // API refuses, so a client that recorded nothing in production passed.
    const sink = await c.sink();
    const open = (body) => fetch(`${sink.url}/v1/sessions`, { method: 'POST', headers: { authorization: 'Bearer k', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const good = { tenant_id: crypto.randomUUID(), agent_id: crypto.randomUUID(), environment_id: crypto.randomUUID(), agent_version: '1' };
    c.assert.equal((await open(good)).status, 201, 'a complete open');
    const { agent_version: _v, ...noVersion } = good;
    c.assert.equal((await open(noVersion)).status, 400, 'an open without agent_version');
    c.assert.equal((await open({ ...good, environment_id: 'prod' })).status, 400, 'an open with an environment_id that is not a UUID');
    const { environment_id: _e, ...noEnv } = good;
    c.assert.equal((await open(noEnv)).status, 400, 'an open without environment_id');
  });
}
