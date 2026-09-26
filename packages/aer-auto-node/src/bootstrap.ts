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

/**
 * Whether this process runs inside an AI coding agent's tool shell. Claude
 * Code exports its own environment, AER_* credentials included, into every
 * command it runs, so a test or build script an agent starts there would
 * otherwise record into the agent's account as if it were the user's run.
 */
export function inAgentToolShell(env: Record<string, string | undefined>): boolean {
  return env['CLAUDECODE'] === '1' || Boolean(env['CLAUDE_CODE_ENTRYPOINT']);
}

/** The explicit opt-in to record inside an agent tool shell anyway. */
export const AGENT_SHELL_OPT_IN = 'AER_RECORD_IN_AGENT_SHELL';

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

  if (inAgentToolShell(env) && env[AGENT_SHELL_OPT_IN] !== '1') {
    // One line, no values: the credentials in play are not ours to print.
    console.warn(
      `[aer:auto] not started: this process runs inside a Claude Code tool shell, whose AER_* settings belong to the agent, not to this program. Set ${AGENT_SHELL_OPT_IN}=1 to record it anyway.`,
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
