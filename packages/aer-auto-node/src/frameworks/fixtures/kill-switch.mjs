// Counts real resolve-hook installations, then loads the collector the way
// --import does. Printed so a test can assert the kill switch installs none.
import { createRequire } from 'node:module';
const nodeModule = createRequire(import.meta.url)('node:module');
let installs = 0;
if (typeof nodeModule.registerHooks === 'function') {
  const real = nodeModule.registerHooks;
  nodeModule.registerHooks = (...a) => { installs += 1; return real(...a); };
}
const { bootstrap } = await import(process.env.AER_BOOTSTRAP_MODULE);
const collector = bootstrap();
process.stdout.write(`INSTALLS:${installs} COLLECTOR:${collector === null ? 'null' : 'made'}\n`);
