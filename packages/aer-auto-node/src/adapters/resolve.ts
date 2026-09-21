// Shared adapter plumbing: best-effort module loading + the injectable resolver
// type the adapters use to locate an SDK's `create` prototype.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { esmEntryOf } from './esm-entry.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ProtoTarget = Record<string, any>;

export interface AdapterDeps {
  /** Override prototype resolution (tests inject a fake `{ create }`). */
  resolveProto?: () => ProtoTarget | null;
}

export interface AdapterInstall {
  /** True when the SDK was found and its method patched. */
  enabled: boolean;
  uninstall: () => void;
}

let req: NodeRequire | null = null;
function nodeRequire(): NodeRequire {
  if (!req) req = createRequire(import.meta.url);
  return req;
}

/** Load an installed module by name; return null if it isn't present. */
export function loadModule(name: string): unknown | null {
  try {
    return nodeRequire()(name);
  } catch {
    return null;
  }
}

/**
 * A require anchored to the APP, not to this package. Resolving from the
 * collector's own location finds whatever copy sits near the collector, which
 * under pnpm, a global install or a shared NODE_OPTIONS is not the copy the
 * app imports.
 */
function appRequire(): NodeRequire {
  try {
    const entry = process.argv[1];
    if (entry !== undefined && entry !== '') return createRequire(pathToFileURL(entry));
  } catch { /* fall through to our own location */ }
  return nodeRequire();
}

/** Load a module by name from the app's position; null when not installed. */
export function loadAppModule(name: string): unknown | null {
  try {
    return appRequire()(name);
  } catch {
    return null;
  }
}

/**
 * Both physical copies of a dual-published package. `openai` resolves to
 * index.mjs for an ESM importer and index.js for a CJS one, and those are
 * different classes with different prototypes: patching the CJS copy leaves
 * an ESM app completely uninstrumented.
 *
 * Resolution is compared first so a single-format package is loaded once.
 */
export async function loadModuleCopies(name: string): Promise<unknown[]> {
  const out: unknown[] = [];
  let cjsPath: string | undefined;
  try {
    cjsPath = appRequire().resolve(name);
  } catch { /* no CJS entry */ }

  // Anchored to the APP: `import()` here would resolve against the collector,
  // and import.meta.resolve's parent argument needs a flag. So the package is
  // located through the app's own CJS resolution and its ESM entry is read
  // from its package.json.
  const esmUrl = cjsPath !== undefined ? esmUrlFrom(name, cjsPath) : undefined;

  const cjs = cjsPath !== undefined ? loadAppModule(name) : null;
  if (cjs !== null) out.push(cjs);

  // Same file behind both specifiers means one copy, so do not pay for a
  // second load of it.
  const sameFile = cjsPath !== undefined && esmUrl !== undefined
    && pathToFileURL(cjsPath).href === esmUrl;
  if (esmUrl !== undefined && !sameFile) {
    try {
      out.push(await import(esmUrl));
    } catch {
      // An exports map with no `import` condition, or a module that throws on
      // load. The CJS copy, if any, still stands.
    }
  }
  return out;
}

/** The ESM entry URL of the package owning `cjsPath`, when it has one. */
function esmUrlFrom(name: string, cjsPath: string): string | undefined {
  try {
    const marker = `node_modules${sep}${name.split('/').join(sep)}${sep}`;
    const at = cjsPath.lastIndexOf(marker);
    if (at === -1) return undefined;
    const pkgDir = cjsPath.slice(0, at + marker.length);
    const pkg: unknown = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    const entry = esmEntryOf(pkg);
    return entry === undefined ? undefined : pathToFileURL(join(pkgDir, entry)).href;
  } catch {
    return undefined;
  }
}
