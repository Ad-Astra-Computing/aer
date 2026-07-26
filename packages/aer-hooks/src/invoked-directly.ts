import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when this module is the program entry point, false when it was imported
 * (e.g. by a test).
 *
 * The naive check `import.meta.url === \`file://\${process.argv[1]}\`` is WRONG
 * for a published bin: npm installs a `node_modules/.bin/<name>` symlink and
 * invokes THAT, so `process.argv[1]` is the symlink path while `import.meta.url`
 * is the realpath of the compiled `dist/*.js`. The two never match, the guard
 * never fires, and the binary is a silent no-op for every real user (local
 * install, `npm i -g`, `npx`). Comparing realpaths fixes it: `realpathSync`
 * resolves the symlink to the same file `import.meta.url` points at.
 *
 * Fails closed (returns false) if `argv[1]` is unset or cannot be resolved, so a
 * weird launcher never spuriously auto-runs.
 */
export function isInvokedDirectly(moduleUrl: string): boolean {
  try {
    return (
      process.argv[1] !== undefined &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl))
    );
  } catch {
    return false;
  }
}
