// Event sinks for the MCP recorder.
//
// The emit core now lives in @adastracomputing/aer-emit so the recorder and the
// hook adapters share exactly one implementation and never drift. This module
// re-exports that core and preserves the recorder's historical public surface:
// `sinkFromEnv` here returns `EventSink | null` (null when unconfigured), which is
// what the recorder CLI and existing consumers expect.

import {
  createHttpSink,
  sinkFromEnv as emitSinkFromEnv,
  NullSink,
  type EventSink,
  type HttpSinkOptions,
  type Principal,
} from '@adastracomputing/aer-emit';
import { COLLECTOR_VERSION } from './recorder.js';

export { createHttpSink, NullSink };
export type { EventSink, HttpSinkOptions, Principal };

/**
 * Default AER_AGENT_VERSION when the customer does not set one. POST /v1/sessions
 * requires agent_version; without a default, an unset var 400s the first session
 * open and the sink disables itself for the rest of the process, recording
 * nothing for the whole run.
 */
const DEFAULT_AGENT_VERSION = `mcp-recorder/${COLLECTOR_VERSION}`;

/**
 * Build an HTTP sink from the standard AER environment variables, or return null
 * when the environment is not configured (no API key, no identity). A null return
 * tells the proxy to no-op recording while still forwarding bytes.
 *
 * Wraps aer-emit's `sinkFromEnv` (which returns a NullSink when unconfigured) and
 * maps that NullSink back to `null` so the recorder's long-standing API is intact.
 */
export function sinkFromEnv(env: NodeJS.ProcessEnv = process.env): EventSink | null {
  const withAgentVersion: NodeJS.ProcessEnv =
    env['AER_AGENT_VERSION'] !== undefined ? env : { ...env, AER_AGENT_VERSION: DEFAULT_AGENT_VERSION };
  const sink = emitSinkFromEnv(withAgentVersion, { logLabel: 'aer-mcp-recorder' });
  return sink instanceof NullSink ? null : sink;
}
