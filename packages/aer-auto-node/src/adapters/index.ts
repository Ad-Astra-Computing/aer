// SDK adapter installer: turns configured adapter names into installed adapters
// and reports which were actually enabled (SDK present). Mirrors the transport
// patch installer. Adapters are ON by default when their SDK is detected.

import type { CollectorEvent } from '../session.js';
import type { AdapterDeps, AdapterInstall } from './resolve.js';
import type { PolicyOptionSource, CommitOption } from './llm-core.js';
import { AdapterStats } from './stats.js';
import { installOpenAIAdapter } from './openai.js';
import { installAnthropicAdapter } from './anthropic.js';
import { installVercelAdapter } from './vercel.js';

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
    const result = install(capture, perAdapterDeps[name] ?? {}, stats, policy, commit);
    if (result.enabled) {
      enabled.push(name);
      uninstalls.push(result.uninstall);
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
export { AdapterStats, type AdapterCallCounts } from './stats.js';
export type { PolicyOption, PolicyOptionSource, CommitOption } from './llm-core.js';
