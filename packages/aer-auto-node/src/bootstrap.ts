// Bootstrap: resolve config, decide whether to run, build the collector, and
// install process lifecycle hooks. Kept pure-ish (deps injectable) so the
// decision logic is unit-tested without touching real process events.

import { resolveConfig, type AerAutoConfig } from './config.js';
import { loadConfigFile } from './config-file.js';
import { createCollector, type Collector } from './collector.js';
import { setActiveCollector } from './state.js';

export interface BootstrapDeps {
  env?: Record<string, string | undefined>;
  cwd?: string;
  createColl?: (config: AerAutoConfig) => Collector;
  installHooks?: (collector: Collector) => void;
}

/** A session can only be opened with the API key (secret) plus full identity. */
export function isConfigured(config: AerAutoConfig): boolean {
  return Boolean(config.apiKey && config.tenantId && config.agentId && config.envId);
}

export function bootstrap(deps: BootstrapDeps = {}): Collector | null {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();

  const config = resolveConfig({ env, configFile: loadConfigFile(cwd) });

  // Kill switch: do nothing - no patches, no session, no further config reads.
  if (config.disabled) return null;

  if (!isConfigured(config)) {
    // Graceful no-op: the host app runs unaffected; `aer doctor` explains the gap.
    console.warn(
      '[aer:auto] not started: missing AER_API_KEY and/or tenant/agent/env identity. Run `npx @adastracomputing/aer doctor`.',
    );
    return null;
  }

  const collector = (deps.createColl ?? createCollector)(config);
  setActiveCollector(collector);
  (deps.installHooks ?? installLifecycleHooks)(collector);
  return collector;
}

/**
 * Wire process lifecycle to the collector. Best-effort by design (see ADR-008):
 * clean exit completes the AER; crashes/signals abort it.
 */
export function installLifecycleHooks(collector: Collector): void {
  let closing = false;

  process.once('beforeExit', () => {
    if (closing) return;
    closing = true;
    void collector.complete();
  });

  process.once('uncaughtException', (err) => {
    void collector.abort();
    throw err; // preserve default crash behavior
  });

  process.once('unhandledRejection', () => {
    void collector.abort();
  });

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      const code = sig === 'SIGINT' ? 130 : 143;
      void collector.abort().finally(() => process.exit(code));
    });
  }
}
