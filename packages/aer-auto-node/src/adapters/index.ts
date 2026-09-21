// SDK adapter installer: turns configured adapter names into installed adapters
// and reports which were actually enabled (SDK present). Mirrors the transport
// patch installer. Adapters are ON by default when their SDK is detected.

import type { CollectorEvent } from '../session.js';
import type { AdapterDeps, AdapterInstall } from './resolve.js';
import type { PolicyOptionSource, CommitOption } from './llm-core.js';
import { AdapterStats } from './stats.js';
import { installOpenAIAdapter, openaiConfig, OPENAI_PACKAGE, openaiProtoOf } from './openai.js';
import { installAnthropicAdapter, anthropicConfig, ANTHROPIC_PACKAGE, anthropicProtoOf } from './anthropic.js';
import { installVercelAdapter } from './vercel.js';
import { installVercelProviderAdapter } from './vercel-provider.js';
import { loadModuleCopies, type ProtoTarget } from './resolve.js';
import { patchMethod, wrapCreate, type ProviderConfig } from './llm-core.js';

type Capture = (event: CollectorEvent) => void;

const REGISTRY: Record<string, (capture: Capture, deps?: AdapterDeps, stats?: AdapterStats, policy?: PolicyOptionSource, commit?: CommitOption) => AdapterInstall> = {
  openai: installOpenAIAdapter,
  anthropic: installAnthropicAdapter,
  vercel: installVercelAdapter,
};

export interface InstalledAdapters {
  /** Names of adapters whose SDK was found and patched. */
  enabled: string[];
  /** Tear down every enabled adapter. Never throws. */
  uninstall: () => void;
  /**
   * Shared per-provider activity counters (calls/ok/error/tool_selections).
   * Optional so test-injected installers need not provide one; the real
   * installAdapters always does.
   */
  stats?: AdapterStats;
}

// A dual-published package has two physical copies with two different class
// objects. The sync pass above patches the one `require` finds; this reaches
// the one an ESM app imports, which is the one most agents actually use.
const COPY_TARGETS: Record<string, { pkg: string; protoOf: (mod: unknown) => ProtoTarget | null; config: () => ProviderConfig; symbol: string }> = {
  openai: { pkg: OPENAI_PACKAGE, protoOf: openaiProtoOf, config: () => openaiConfig, symbol: 'openai' },
  anthropic: { pkg: ANTHROPIC_PACKAGE, protoOf: anthropicProtoOf, config: () => anthropicConfig, symbol: 'anthropic' },
};

/**
 * Patch every copy of each adapter's package that the app could be using.
 * Awaited by the register entry point before the app loads, so there is no
 * window in which a call can miss the wrapper.
 */
export async function patchRemainingCopies(
  capture: Capture,
  adapterNames: string[],
  stats: AdapterStats,
  policy?: PolicyOptionSource,
  commit?: CommitOption,
): Promise<{ enabled: string[]; uninstall: () => void }> {
  const enabled: string[] = [];
  const uninstalls: Array<() => void> = [];

  // The Vercel facade cannot be patched at all (its namespace is sealed), so
  // it is instrumented one layer down, at the provider model classes.
  if (adapterNames.includes('vercel')) {
    try {
      const installed = await installVercelProviderAdapter(capture, stats);
      if (installed.enabled) {
        enabled.push('vercel-provider');
        uninstalls.push(installed.uninstall);
      }
    } catch { /* never a reason to fail the host */ }
  }

  for (const name of adapterNames) {
    const target = COPY_TARGETS[name];
    if (!target) continue;
    try {
      for (const mod of await loadModuleCopies(target.pkg)) {
        const proto = target.protoOf(mod);
        if (!proto) continue;
        // Already patched in the sync pass is a no-op: the guard is keyed on
        // the target object, and the two copies are different objects.
        const uninstall = patchMethod(
          proto, 'create',
          (orig) => wrapCreate(orig, target.config(), capture, stats, policy, commit),
          target.symbol,
        );
        if (uninstall) {
          uninstalls.push(uninstall);
          if (!enabled.includes(name)) enabled.push(name);
        }
      }
    } catch {
      // Not instrumentable. Never a reason to fail the host.
    }
  }

  return { enabled, uninstall: () => { for (const u of uninstalls) { try { u(); } catch { /* best-effort */ } } } };
}

export function installAdapters(
  capture: Capture,
  adapterNames: string[],
  perAdapterDeps: Record<string, AdapterDeps> = {},
  policy?: PolicyOptionSource,
  commit?: CommitOption,
): InstalledAdapters {
  const enabled: string[] = [];
  const uninstalls: Array<() => void> = [];
  const stats = new AdapterStats();

  for (const name of adapterNames) {
    const install = REGISTRY[name];
    if (!install) continue;
    // One SDK the collector cannot instrument disables that adapter and
    // nothing else. This runs during the customer's startup, so a throw here
    // would stop their program before it began.
    try {
      const result = install(capture, perAdapterDeps[name] ?? {}, stats, policy, commit);
      if (result.enabled) {
        enabled.push(name);
        uninstalls.push(result.uninstall);
      }
    } catch {
      // Not instrumentable. The record will say so by omission.
    }
  }

  return {
    enabled,
    stats,
    uninstall: () => {
      for (const u of uninstalls) {
        try { u(); } catch { /* best-effort teardown */ }
      }
    },
  };
}

export { installOpenAIAdapter, openaiConfig } from './openai.js';
export { installAnthropicAdapter, anthropicConfig } from './anthropic.js';
export { installVercelAdapter, vercelConfig } from './vercel.js';
export { installVercelProviderAdapter } from './vercel-provider.js';
export { AdapterStats, type AdapterCallCounts } from './stats.js';
export type { PolicyOption, PolicyOptionSource, CommitOption } from './llm-core.js';
