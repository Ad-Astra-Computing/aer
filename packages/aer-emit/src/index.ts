// @adastracomputing/aer-emit - the shared best-effort AER emit core.
//
// One place for the AER session/emit client so producers (aer-mcp-recorder,
// aer-hooks) never drift. Every network operation is best-effort and never throws;
// an unconfigured environment yields a NullSink that does nothing.

export { NullSink, createHttpSink } from './sink.js';
export type { EventSink, HttpSinkOptions, Principal } from './sink.js';
export { resolvePrincipal } from './principal.js';
export type { PrincipalKind } from './principal.js';
export { sinkFromEnv, resolveSinkOptionsFromEnv } from './env.js';
export type { SinkEnvOverrides } from './env.js';
