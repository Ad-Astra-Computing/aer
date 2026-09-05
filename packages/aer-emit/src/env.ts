// Build an EventSink from the standard AER environment variables.
//
// Returns NullSink when the environment is not configured (no API key, or missing
// tenant/agent identity). This lets a producer wire the sink unconditionally and
// have it no-op when AER is not set up.

import { createHttpSink, NullSink, type EventSink, type HttpSinkOptions } from './sink.js';
import { resolvePrincipal, type Principal } from './principal.js';

export interface SinkEnvOverrides {
  fetch?: typeof fetch | undefined;
  batchSize?: number | undefined;
  logError?: ((message: string) => void) | undefined;
  logLabel?: string | undefined;
}

/**
 * Build an EventSink from AER_* env vars, or NullSink when unconfigured. Reads
 * AER_API_KEY (or AER_TENANT_API_KEY as a fallback) / AER_TENANT_ID /
 * AER_AGENT_ID / AER_ENV_ID / AER_BASE_URL / AER_AGENT_VERSION and
 * AER_PRINCIPAL_ID / _KIND / _DISPLAY.
 */
/**
 * Resolve HttpSinkOptions from AER_* env vars, or null when unconfigured. Lets a
 * caller that needs finer control (attach to an existing session, defer the
 * /complete) build the sink itself with createHttpSink instead of taking the
 * ready-made sink from {@link sinkFromEnv}.
 */
export function resolveSinkOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: SinkEnvOverrides = {},
): HttpSinkOptions | null {
  // AER_TENANT_API_KEY is accepted as a fallback name for the same secret;
  // the CLI and this ecosystem's docs use both names interchangeably.
  const apiKey = env['AER_API_KEY'] ?? env['AER_TENANT_API_KEY'];
  const tenantId = env['AER_TENANT_ID'];
  const agentId = env['AER_AGENT_ID'];
  if (!apiKey || !tenantId || !agentId) return null;
  const baseUrl = env['AER_BASE_URL'] ?? 'https://api.aer.run';

  const principal: Principal | undefined = resolvePrincipal(
    env['AER_PRINCIPAL_ID'],
    env['AER_PRINCIPAL_KIND'],
    env['AER_PRINCIPAL_DISPLAY'],
  );

  const options: HttpSinkOptions = { baseUrl, apiKey, tenantId, agentId };
  const environmentId = env['AER_ENV_ID'];
  if (environmentId !== undefined) options.environmentId = environmentId;
  const agentVersion = env['AER_AGENT_VERSION'];
  if (agentVersion !== undefined) options.agentVersion = agentVersion;
  if (principal !== undefined) options.principal = principal;
  if (overrides.fetch !== undefined) options.fetch = overrides.fetch;
  if (overrides.batchSize !== undefined) options.batchSize = overrides.batchSize;
  if (overrides.logError !== undefined) options.logError = overrides.logError;
  if (overrides.logLabel !== undefined) options.logLabel = overrides.logLabel;

  return options;
}

export function sinkFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: SinkEnvOverrides = {},
): EventSink {
  const options = resolveSinkOptionsFromEnv(env, overrides);
  if (!options) return new NullSink();
  return createHttpSink(options);
}
