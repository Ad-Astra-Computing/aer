// Loaded before every test file (vitest setupFiles). Never shipped.
//
// A developer shell can export real AER credentials, and a child spawned with
// them records into the live service. Every AER_* variable is removed first,
// and a child or fetch that could still reach the live service fails the test.

import * as childProcess from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const LIVE_HOST = /(^|\.)aer\.run$/i;

for (const key of Object.keys(process.env)) {
  if (key.startsWith('AER_')) delete process.env[key];
}

function liveHostIn(value: string): boolean {
  for (const match of value.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi)) {
    try {
      if (LIVE_HOST.test(new URL(match[0]).hostname)) return true;
    } catch {
      /* not a URL after all */
    }
  }
  return false;
}

/** Why this environment could reach the live service, or undefined when it cannot. */
export function liveServiceReason(env: NodeJS.ProcessEnv): string | undefined {
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && liveHostIn(value)) return `${key} names the live AER service`;
  }
  const hasKey = Boolean(env['AER_API_KEY'] ?? env['AER_TENANT_API_KEY']);
  if (hasKey && !env['AER_BASE_URL']) return 'an AER key with no AER_BASE_URL defaults to the live AER service';
  return undefined;
}

function refuse(reason: string): never {
  throw new Error(`test environment guard: refusing to reach the live AER service (${reason})`);
}

function optionsOf(args: unknown[]): { env?: NodeJS.ProcessEnv } | undefined {
  for (const a of args.slice(1)) {
    if (typeof a === 'object' && a !== null && !Array.isArray(a)) return a as { env?: NodeJS.ProcessEnv };
  }
  return undefined;
}

const require = createRequire(import.meta.url);
const cp = require('node:child_process') as Record<string, unknown>;
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
  const original = cp[name] as ((...args: unknown[]) => unknown) | undefined;
  if (typeof original !== 'function') continue;
  cp[name] = function guarded(this: unknown, ...args: unknown[]): unknown {
    const env = optionsOf(args)?.env ?? process.env;
    const reason = liveServiceReason(env);
    if (reason !== undefined) refuse(reason);
    return original.apply(this, args);
  };
}
// ESM named imports of node:child_process read the builtin's live exports;
// this republishes the patched functions to them.
syncBuiltinESMExports();
void childProcess;

const originalFetch = globalThis.fetch;
globalThis.fetch = async function guardedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (liveHostIn(url)) refuse(`fetch ${new URL(url).hostname}`);
  return originalFetch(input, init);
};
