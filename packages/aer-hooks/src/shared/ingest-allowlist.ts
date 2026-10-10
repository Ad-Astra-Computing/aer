// The payload keys AER ingest will actually store. Every other key is dropped
// at POST /v1/sessions/:id/events, so a client that sends one pays the privacy
// cost and gets nothing in the record. Source of truth is
// BODIES_OFF_PAYLOAD_KEYS in the API repo, which pins the same digest.
//
// harness_agent_id, subagent_events_unattached and events_dropped_budget are
// listed ahead of the server allowlist, which strips and counts them until it
// accepts them; listing them now avoids a second client release.
//
// decided_by and approvals_unresolved (P0-1 oversight markers) are aer-hooks
// only; a key this package never sends is harmless.
//
// path_class, hash_status, sha256_before, sha256_after and bytes (effects
// recording, P0-2) are new on this side: path_class is the client's own
// classification of a file.written path (the server never trusts it alone),
// and the other four carry a keyed HMAC file-content digest. See
// hashable-path-classes.ts for the gate that decides when a digest is sent.

export const INGEST_PAYLOAD_KEYS: ReadonlySet<string> = new Set<string>([
  'provider', 'model', 'agent', 'name', 'source', 'status', 'streaming', 'tools_available',
  'input_tokens', 'output_tokens', 'tokens', 'stop_reason', 'usage_observed',
  'duration_ms', 'ok', 'error', 'response_captured', 'request_ref', 'kid', 'canon',
  'capture_point', 'prompt_canon_tag', 'wire_canon', 'wire_canon_tag', 'tool_result_tags',
  'tool_args_tag', 'message_count', 'prompt_bytes', 'retained', 'outcome', 'response_tag',
  'tool', 'host', 'method', 'status_code', 'url', 'path_redacted', 'scheme',
  'secure', 'response_bytes', 'command', 'args_redacted', 'pid', 'exit_code',
  'command_known', 'path', 'key', 'rule', 'decision', 'policy_id', 'version',
  'mode', 'limit', 'observed', 'action', 'classes', 'runtime', 'node_version',
  'collector', 'session_strategy', 'capture_policy', 'enabled_patches', 'enabled_adapters',
  'adapter_activity', 'phase', 'reason', 'attestation', 'audience', 'package_manager',
  'packages', 'lockfile_hash', 'snapshot_hash', 'versions', 'arg_keys', 'is_error',
  'result_size', 'kind', 'protocol_version', 'client_name', 'client_version',
  'count', 'tools', 'recorder', 'server', 'tools_seen', 'calls', 'errors', 'error_code',
  'session_ref', 'frameworks', 'providers', 'adapters', 'calls_recorded', 'provider_requests',
  'coverage', 'harness', 'permission_mode', 'effort', 'repo_head', 'seq', 'turn_id',
  'tool_use_id', 'parent_tool_use_id', 'agent_type', 'events_registered', 'events_emitted', 'tools_unresolved',
  'run_id', 'thread_id', 'main_thread', 'harness_agent_id',
  'subagent_events_unattached', 'events_dropped_budget',
  'decided_by', 'approvals_unresolved',
  'path_class', 'hash_status', 'sha256_before', 'sha256_after', 'bytes',
  'effect_stashes_unattached',
  // Malicious-behaviour detection slice 1 (aer-malicious-behaviour-detection-
  // design.md section 4): closed-set labels computed from argv/paths that
  // are discarded before the event is sent. Mirrors BODIES_OFF_PAYLOAD_KEYS's
  // own slice 1 addition in the API repo. path_class is already listed above.
  'verb', 'flags', 'target_class', 'path_count', 'glob', 'paths_touched_classes',
  'search_class', 'wrapper', 'wrapper_flags', 'elevated',
  'target_user_class', 'cap_class', 'group_class', 'gtfobin_elevation', 'upload',
  'stdin_from_class', 'sql_verb', 'where_clause', 'branch_class', 'remote_class',
  'registry_changed', 'context_changed', 'target_process_class', 'env_unset_class',
  'env_set_class', 'history_cleared', 'interpreter_inline', 'ai_cli',
]);

export interface StripResult {
  /** The payload with only keys ingest will store. */
  payload: Record<string, unknown>;
  /** Key names ingest would have dropped, sorted. Never their values. */
  dropped: string[];
}

export function stripToIngestPayload(payload: Record<string, unknown>): StripResult {
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(payload)) {
    if (INGEST_PAYLOAD_KEYS.has(k)) out[k] = v;
    else dropped.push(k);
  }
  dropped.sort();
  return { payload: out, dropped };
}
