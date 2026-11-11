// Shared closed-set types for the Sentinel local-poll sensor.
//
// Wire contract: see docs/specs (private monorepo) "aer-sentinel-local-poll-sensor-v1".
// Bodies-off: every field here is a closed-set enum, a count, a boolean, or a
// hash - never a raw path, argv, hostname, or local port.

/** Known AI CLI/tool labels the local classifier can produce. Never a raw
 * binary name: a process that does not match one of these produces NO row. */
export type Tool =
  | 'claude_code'
  | 'codex'
  | 'cursor'
  | 'gemini_cli'
  | 'aider'
  | 'opencode'
  | 'copilot'
  | 'antigravity';

/** Process classification. 'browser' is terminal: never produces a row. */
export type ProcessClass = 'known_ai_cli' | 'browser';

export type DestinationEvidence = 'provider_owned_range' | 'resolved_exact_ip' | 'none';

export type Instrumentation = 'hooks_configured' | 'none' | 'not_checkable';

/** One row of the wire batch sent to POST /v1/sentinel/local-poll/:sensor_source_id. */
export interface ObservationRow {
  observation_id: string;
  observed_at: string;
  /** Omitted entirely when destination_evidence is 'none'. */
  destination_ip?: string;
  /** Omitted entirely when destination_evidence is 'none'. */
  destination_port?: number;
  destination_evidence: DestinationEvidence;
  destination_family: string | null;
  tool: Tool;
  instrumentation: Instrumentation;
}

/** A local network 4-tuple, used only to derive observation_id locally -
 * never sent on the wire. */
export interface ConnectionTuple {
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
}
