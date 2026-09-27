// Builds the inline `node -e <script>` workload for `aer smoke`.
//
// `node -e` scripts run as plain CommonJS by default. A script that mixes
// ESM-only syntax (a top-level `await`) with CommonJS syntax (`require(...)`)
// is rejected by Node with ERR_AMBIGUOUS_MODULE_SYNTAX before it ever runs -
// Node can't tell whether the whole `-e` string should be parsed as ESM or
// CJS, and refuses to guess. Wrapping the body in an async IIFE keeps the
// OUTER script syntax unambiguous CommonJS (no top-level await - the `await`
// is inside a function expression) while still allowing `require(...)`
// inside it.
export function buildSmokeScript(target: string): string {
  const healthzUrl = JSON.stringify(target.replace(/\/+$/, '') + '/healthz');
  return (
    `(async () => {` +
    `await fetch(${healthzUrl}).catch(() => {});` +
    // An awaited async spawn: every collector version records it, where
    // spawnSync went unrecorded by older collectors.
    `await new Promise((r) => { const c = require('node:child_process').spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' }); c.on('exit', r); c.on('error', r); });` +
    `})();`
  );
}
