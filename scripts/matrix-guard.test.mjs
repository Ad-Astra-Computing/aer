// The installed-package matrix promises that no case reaches the AER service.
// Part of that promise is Node's own proxy support, which only some versions
// have, and part is the harness suite that checks it, which is worth nothing
// if a failure there does not stop the run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proxyGuardSupported } from './matrix/lib/proc.mjs';
import { createRegistry, runSuites } from './matrix/lib/harness.mjs';

test('the network guard needs Node 24.5 or 22.21 and later, never 23', () => {
  for (const v of ['v24.5.0', 'v24.19.0', 'v22.21.0', 'v22.22.1', 'v25.0.0', 'v26.1.0']) {
    assert.equal(proxyGuardSupported(v), true, v);
  }
  for (const v of ['v24.4.1', 'v24.0.0', 'v22.20.0', 'v22.0.0', 'v23.11.0', 'v20.19.0', 'nonsense']) {
    assert.equal(proxyGuardSupported(v), false, v);
  }
});

function registryWith(harnessFails) {
  const reg = createRegistry();
  const h = reg.suite('harness', 'scripts/matrix');
  h.case('guard', (c) => c.assert.ok(!harnessFails, 'guard broken'));
  const later = reg.suite('later', 'pkg');
  let ran = false;
  later.case('would talk to a sink', () => { ran = true; });
  return { reg, ran: () => ran };
}

const env = () => ({ opts: { keep: false }, tmpRoot: `${process.env.TMPDIR ?? '/tmp'}/aer-matrix-guard-test`, log: () => {}, install: {} });

test('a failing harness suite stops the run before any other suite', async () => {
  const { reg, ran } = registryWith(true);
  const results = await runSuites(reg, env(), { gates: ['harness'] });
  assert.equal(ran(), false, 'a later suite ran after the harness failed');
  assert.equal(results.aborted, 'harness');
  assert.deepEqual(results.map((r) => r.status), ['FAIL']);
});

test('a passing harness suite lets the run continue', async () => {
  const { reg, ran } = registryWith(false);
  const results = await runSuites(reg, env(), { gates: ['harness'] });
  assert.equal(ran(), true);
  assert.equal(results.aborted, undefined);
});
