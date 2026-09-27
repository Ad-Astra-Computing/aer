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
}
