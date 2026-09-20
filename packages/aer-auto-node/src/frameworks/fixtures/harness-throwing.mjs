// The recorder faults on every resolve. The agent must not notice.
import { registerHooks } from 'node:module';
registerHooks({
  resolve(spec, ctx, next) {
    const r = next(spec, ctx);
    try { throw new Error('recorder is broken'); } catch { /* swallowed, as in observe.ts */ }
    return r;
  },
});
await import(process.argv[2]);
process.stdout.write('APP-COMPLETED\n');
