import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');

/** Every built file, so a new module cannot reintroduce the problem. */
function builtFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? builtFiles(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : [],
  );
}

describe('nothing statically imports a Node API that may not exist', () => {
  // A missing named export from a builtin is a link-time SyntaxError, not
  // undefined, so a `typeof x === 'function'` guard never gets to run and the
  // customer's process dies at startup before their code loads. registerHooks
  // arrived in 22.15 and this package supports older runtimes.
  const RECENT = ['registerHooks', 'getBuiltinModule', 'registerHooks as'];

  it('reads them off the module object instead', () => {
    if (!existsSync(dist)) throw new Error('build the package first (pretest does)');
    const offenders: string[] = [];
    for (const file of builtFiles(dist)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']node:[a-z/]+["']/g)) {
        for (const name of RECENT) {
          if (m[1]?.includes(name)) offenders.push(`${file}: ${m[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
