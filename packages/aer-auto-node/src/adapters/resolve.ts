// Shared adapter plumbing: best-effort module loading + the injectable resolver
// type the adapters use to locate an SDK's `create` prototype.

import { createRequire } from 'node:module';

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
