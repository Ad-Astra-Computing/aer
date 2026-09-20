// Which agent framework actually loaded in this process. Two sources, since
// neither covers both module systems: require.cache for CJS, a synchronous
// resolve hook for the rest.
//
// The hook is observe-only and every path is wrapped, so a fault reports
// nothing rather than breaking the agent being watched.

import { createRequire, registerHooks } from 'node:module';
import type { ResolveHookSync } from 'node:module';
import { detectFrameworks, frameworkFromSpecifier } from './registry.js';

// The directory holding the collector's OWN modules, so its probing of the
// provider SDKs is never counted as the agent's. Deliberately not the package
// root: only our code, not anything that happens to sit beside it.
const COLLECTOR_DIR = new URL('../', import.meta.url).href;

export interface FrameworkObserver {
  /** Framework names seen so far. Safe to call more than once. */
  observed(): string[];
  /** Remove the resolve hook. Present so tests leave nothing behind. */
  stop(): void;
}

interface HookHandle { deregister?: () => void }

/** Injectable so a test can present the runtime as one without the hooks API. */
export interface ObserverDeps {
  registerHooks?: typeof registerHooks | undefined;
}

export function startFrameworkObserver(deps: ObserverDeps = {}): FrameworkObserver {
  const register = 'registerHooks' in deps ? deps.registerHooks : registerHooks;
  const fromHook = new Set<string>();
  // Anything already required belongs to the collector or to Node, never to
  // the agent: bootstrap probes the provider SDKs before user code runs.
  const before = new Set(safeCacheKeys());
  let handle: HookHandle | null = null;

  try {
    // Absent before Node 22.15. The cache scan then carries the whole job.
    if (typeof register === 'function') {
      const resolve: ResolveHookSync = (specifier, context, next) => {
        const result = next(specifier, context);
        try {
          const parent = context.parentURL;
          if (parent === undefined || !parent.startsWith(COLLECTOR_DIR)) {
            const name = frameworkFromSpecifier(specifier);
            if (name !== undefined) fromHook.add(name);
          }
        } catch {
          // Observation is never worth a failed resolve.
        }
        return result;
      };
      handle = register({ resolve }) as HookHandle;
    }
  } catch {
    handle = null;
  }

  return {
    observed(): string[] {
      const fresh = safeCacheKeys().filter((k) => !before.has(k));
      return rank([...detectFrameworks(fresh), ...fromHook]);
    },
    stop(): void {
      try { handle?.deregister?.(); } catch { /* already gone */ }
    },
  };
}

function safeCacheKeys(): string[] {
  try {
    return Object.keys(createRequire(import.meta.url).cache ?? {});
  } catch {
    return [];
  }
}

// Load order is an accident of the import graph, not of intent: langgraph
// always drags @langchain/core in ahead of itself. So the pick is by role.
// Lower number wins; equal rank sorts alphabetically.
const RANK: Readonly<Record<string, number>> = {
  langgraph: 0, mastra: 0, 'openai-agents': 0, 'claude-agent-sdk': 0,
  beeai: 0, 'inngest-agent-kit': 0, voltagent: 0, 'microsoft-agents': 0,
  agentica: 0, graphai: 0, genkit: 0,
  langchain: 1, llamaindex: 1,
};

/** Deduped, most specific first, so the head is the one worth recording. */
export function rank(names: readonly string[]): string[] {
  return [...new Set(names)].sort((a, b) => {
    const d = (RANK[a] ?? 2) - (RANK[b] ?? 2);
    return d !== 0 ? d : a.localeCompare(b);
  });
}
