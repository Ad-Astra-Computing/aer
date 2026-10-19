// Re-sanitizes a stored event payload before `list_session_events` returns it:
// ingest's own stripping is ingest-only, so a legacy row reads back as stored.
// Re-applies the vendored INGEST_PAYLOAD_KEYS allowlist plus the server's
// value-shape bounds (closed sets, hash formats, non-negative counters, per-
// key length overrides) on the READ path. Mirrors packages/schemas/src/
// event.ts's sanitizePayloadBodiesOff in the private monorepo by hand; not
// vendored/CI-checked against it (no shared CI between the two repos).

import { INGEST_PAYLOAD_KEYS } from '../shared/ingest-allowlist.js';

export const MAX_VALUE_STRING_LEN = 2048;
export const MAX_COMMAND_LEN = 4096;
export const MAX_VALUE_ARRAY_ITEMS = 256;
export const MAX_PACKAGES_ITEMS = 4096;
export const MAX_VALUE_OBJECT_KEYS = 64;
export const MAX_VALUE_DEPTH = 4;
export const CLOSED_SET_ARRAY_MAX = 16;

export const TOKEN_COUNT_ALIASES: ReadonlyMap<string, string> = new Map([
  ['prompt_tokens', 'input_tokens'],
  ['promptTokens', 'input_tokens'],
  ['inputTokens', 'input_tokens'],
  ['completion_tokens', 'output_tokens'],
  ['completionTokens', 'output_tokens'],
  ['outputTokens', 'output_tokens'],
  ['total_tokens', 'tokens'],
  ['totalTokens', 'tokens'],
]);

function isTokenCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

// Per-key string-length overrides, tighter than the generic cap.
const VALUE_STRING_LEN_OVERRIDES: ReadonlyMap<string, number> = new Map([
  ['harness_agent_id', 128],
  ['agent_type', 64],
  ['harness', 64],
  ['permission_mode', 64],
  ['request_ref', 128],
]);

// Malicious-behaviour-detection slice 1 + config.changed closed sets.
const VERB_SET = new Set<string>([
  'git push', 'git push --force', 'git reset', 'git reset --hard', 'git branch -D',
  'git clean', 'git checkout --', 'rm', 'find -delete', 'dd', 'mkfs', 'shred', 'truncate',
  'aws s3 rm', 'aws rds delete-db-instance', 'gcloud delete', 'az delete',
  'kubectl delete', 'terraform destroy', 'docker system prune', 'npm publish',
  'pnpm publish', 'yarn publish', 'cargo publish', 'twine upload', 'gem push',
  'docker push', 'gh release create', 'gh repo create', 'git remote set-url',
  'psql -c', 'mysql -e', 'sqlite3', 'crontab', 'launchctl', 'systemctl', 'git config',
  'npm config', 'kill', 'pkill', 'kubectl', 'aws', 'gcloud', 'az', 'ssh', 'scp',
  'sysctl', 'sudoedit', 'windows_runas', 'gh auth token', 'aws sts get-session-token',
  'gcloud auth print-access-token', 'az account get-access-token', 'kubectl config view --raw',
  'docker login', 'npm token', 'trufflehog', 'gitleaks', 'aws sts assume-role',
  'gcloud --impersonate-service-account', 'az role assignment create',
  'insmod', 'modprobe', 'kexec', 'authopen', 'security', 'tccutil',
  'chmod', 'setcap', 'other',
]);
const FLAGS_SET = new Set<string>([
  'recursive', 'force', 'no_preserve_root', 'hard', 'delete', 'prune', 'all', 'quiet', 'yes',
  'setuid', 'setgid', 'owner_root', 'privileged', 'host_mount', 'cap_add', 'pid_host',
  'net_host', 'map_root', 'tags', 'public',
]);
const TARGET_CLASS_SET = new Set<string>([
  'root', 'home', 'repo_root', 'vcs_dir', 'build_dir', 'dep_dir', 'parent_of_cwd',
  'outside_cwd', 'in_cwd', 'device', 'unknown',
]);
const PATH_CLASS_SET = new Set<string>([
  'root', 'home', 'repo_root', 'vcs_dir', 'build_dir', 'dep_dir', 'parent_of_cwd',
  'outside_cwd', 'in_cwd', 'device', 'config', 'secret', 'source', 'other', 'unknown',
]);
const WRAPPER_SET = new Set<string>([
  'sudo', 'sudoedit', 'doas', 'su', 'pkexec', 'run0', 'systemd-run', 'machinectl',
  'mdo', 'env', 'nice', 'timeout', 'xargs', 'other',
]);
const WRAPPER_FLAGS_SET = new Set<string>([
  '-u', '-i', '-s', '-E', '-l', '-v', '-k', '-n', '-c', '-m', '-p',
  '--uid', '--pty', '--shell', '--scope', '--unit', '--user',
]);
const CAP_CLASS_SET = new Set<string>(['setuid', 'setgid', 'sys_admin', 'dac_override', 'sys_ptrace', 'net_raw', 'net_bind', 'other']);
const GROUP_CLASS_SET = new Set<string>(['sudo', 'wheel', 'admin', 'adm', 'docker', 'lxd', 'disk', 'kvm', 'shadow', 'root', 'other']);
const TARGET_USER_CLASS_SET = new Set<string>(['root', 'other']);
const SQL_VERB_SET = new Set<string>(['drop', 'truncate', 'delete', 'alter', 'other']);
const BRANCH_CLASS_SET = new Set<string>(['protected', 'other']);
const REMOTE_CLASS_SET = new Set<string>(['origin', 'new']);
const TARGET_PROCESS_CLASS_SET = new Set<string>(['recorder', 'harness', 'other']);
const ENV_UNSET_CLASS_SET = new Set<string>(['aer', 'other']);
const ENV_SET_CLASS_SET = new Set<string>(['loader', 'other']);
const HASH_STATUS_SET = new Set<string>(['ok', 'credential_class', 'size', 'unreadable', 'symlink', 'not_regular_file', 'outside_workspace', 'no_key']);
const CONFIG_SOURCE_SET = new Set<string>(['user_settings', 'project_settings', 'local_settings', 'policy_settings', 'skills', 'other']);
const CONFIG_TRIGGER_SET = new Set<string>(['session_start', 'config_change']);
const CONFIG_STATUS_SET = new Set<string>(['ok', 'absent', 'unparseable', 'too_large', 'unreadable', 'not_parsed']);
const DEFAULT_MODE_SET = new Set<string>(['plan', 'dontAsk', 'default', 'auto', 'acceptEdits', 'bypassPermissions', 'unset', 'other']);
const CONFIG_WRITER_SET = new Set<string>(['write_tool', 'shell_named', 'shell_unnamed', 'prompt_grant', 'none_observed']);
const CONFIG_CHANGE_SET = new Set<string>([
  'deny_removed', 'ask_removed', 'allow_broadened', 'default_mode_loosened',
  'bypass_guard_removed', 'dirs_added', 'mcp_auto_enabled', 'sandbox_disabled',
  'hooks_disabled_on', 'aer_hooks_removed',
  'allow_added', 'allow_removed', 'deny_added', 'hooks_added', 'hooks_removed',
  'default_mode_tightened', 'content_only',
  'file_created', 'file_deleted', 'prior_unknown',
]);
const CANON_SET = new Set<string>(['aer-canon.v1']);
const WIRE_CANON_SET = new Set<string>(['aer-wire.v1']);
const CAPTURE_POINT_SET = new Set<string>(['adapter_request']);
const RETAINED_SET = new Set<string>(['none', 'customer_ref']);
const OUTCOME_SET = new Set<string>(['ok', 'error', 'aborted', 'partial', 'accepted', 'rejected', 'unknown']);

const CLOSED_SET_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['canon', CANON_SET],
  ['wire_canon', WIRE_CANON_SET],
  ['capture_point', CAPTURE_POINT_SET],
  ['retained', RETAINED_SET],
  ['outcome', OUTCOME_SET],
  ['verb', VERB_SET],
  ['flags', FLAGS_SET],
  ['target_class', TARGET_CLASS_SET],
  ['paths_touched_classes', PATH_CLASS_SET],
  ['path_class', PATH_CLASS_SET],
  ['search_class', PATH_CLASS_SET],
  ['stdin_from_class', PATH_CLASS_SET],
  ['wrapper', WRAPPER_SET],
  ['wrapper_flags', WRAPPER_FLAGS_SET],
  ['cap_class', CAP_CLASS_SET],
  ['group_class', GROUP_CLASS_SET],
  ['target_user_class', TARGET_USER_CLASS_SET],
  ['sql_verb', SQL_VERB_SET],
  ['branch_class', BRANCH_CLASS_SET],
  ['remote_class', REMOTE_CLASS_SET],
  ['target_process_class', TARGET_PROCESS_CLASS_SET],
  ['env_unset_class', ENV_UNSET_CLASS_SET],
  ['env_set_class', ENV_SET_CLASS_SET],
  ['hash_status', HASH_STATUS_SET],
  ['config_source', CONFIG_SOURCE_SET],
  ['trigger', CONFIG_TRIGGER_SET],
  ['config_status', CONFIG_STATUS_SET],
  ['default_mode', DEFAULT_MODE_SET],
  ['writer', CONFIG_WRITER_SET],
  ['config_changes', CONFIG_CHANGE_SET],
]);

const HEX64_KEYS: ReadonlySet<string> = new Set(['sha256_before', 'sha256_after', 'prompt_canon_tag', 'wire_canon_tag', 'tool_args_tag', 'response_tag']);
const HEX64_RE = /^[0-9a-f]{64}$/;
const HEX64_ARRAY_KEYS: ReadonlySet<string> = new Set(['tool_result_tags']);
const SHA256_PREFIXED_KEYS: ReadonlySet<string> = new Set(['lockfile_hash', 'snapshot_hash']);
const SHA256_PREFIXED_RE = /^sha256:[0-9a-f]{64}$/;
const HEX16_KEYS: ReadonlySet<string> = new Set(['kid']);
const HEX16_RE = /^[0-9a-f]{16}$/;
const HEX_REF_KEYS: ReadonlySet<string> = new Set(['before_ref', 'after_ref', 'repo_head']);
const HEX_REF_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

const BOOLEAN_KEYS: ReadonlySet<string> = new Set([
  'glob', 'elevated', 'gtfobin_elevation', 'upload', 'where_clause',
  'registry_changed', 'context_changed', 'history_cleared', 'interpreter_inline',
  'hooks_disabled',
]);

const NONNEGATIVE_INT_KEYS: ReadonlySet<string> = new Set([
  'subagent_events_unattached', 'events_dropped_budget', 'seq', 'hosts_unreduced',
  'path_count', 'approvals_unresolved', 'bytes', 'effect_stashes_unattached',
  'vcs_push_stashes_unattached', 'message_count', 'prompt_bytes',
  'allow_rules', 'deny_rules', 'broad_allow_rules', 'aer_hook_count',
]);
const NONNEGATIVE_INT_MAX: ReadonlyMap<string, number> = new Map([
  ['seq', 2 ** 32],
  ['path_count', 4096],
  ['bytes', 10 * 1024 * 1024],
  ['allow_rules', 4096],
  ['deny_rules', 4096],
  ['broad_allow_rules', 4096],
  ['aer_hook_count', 256],
]);

const ALSO_RAN_MAX_ITEMS = 16;
const ALSO_RAN_ITEM_MAX_LEN = 256;
// eslint-disable-next-line no-control-regex
const ALSO_RAN_FORBIDDEN = /[\s/\\\u0000-\u001f\u007f]/;

function isExecutableName(v: unknown): boolean {
  return typeof v === 'string' && v.length > 0 && v.length <= ALSO_RAN_ITEM_MAX_LEN && !ALSO_RAN_FORBIDDEN.test(v);
}
function isExecutableNameList(v: unknown): boolean {
  return Array.isArray(v) && v.length <= ALSO_RAN_MAX_ITEMS && v.every(isExecutableName);
}

const NAME_MAX_LEN = 256;
// eslint-disable-next-line no-control-regex
const NAME_FORBIDDEN_CONTROL = /[\u0000-\u001f\u007f]/;
function isSafeName(v: unknown): boolean {
  return typeof v === 'string' && v.length > 0 && v.length <= NAME_MAX_LEN && !NAME_FORBIDDEN_CONTROL.test(v);
}
function isSafeNameList(v: unknown): boolean {
  return Array.isArray(v) && v.length <= MAX_VALUE_ARRAY_ITEMS && v.every(isSafeName);
}

const AI_CLI_NAME_SET: ReadonlySet<string> = new Set(['claude', 'codex', 'gemini', 'copilot', 'opencode', 'q']);
const AI_CLI_BYPASS_FLAG_SET: ReadonlySet<string> = new Set([
  '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions',
  '--permission-mode=bypassPermissions', '--dangerously-bypass-approvals-and-sandbox',
  '--full-auto', '--yolo', '-y', '--approval-mode=yolo', '--ask-for-approval=never',
  'danger-full-access', '--autopilot', '--allow-all', '--trust-all-tools', '--no-interactive',
]);

function filterClosedSetArray(v: unknown, allowed: ReadonlySet<string>): string[] | null {
  if (!Array.isArray(v) || v.length > CLOSED_SET_ARRAY_MAX) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string' && allowed.has(item)) out.push(item);
  }
  return out;
}

function sanitizeAiCli(v: unknown): Record<string, unknown> | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const obj = v as Record<string, unknown>;
  const name = obj['name'];
  if (typeof name !== 'string' || !AI_CLI_NAME_SET.has(name)) return null;
  const out: Record<string, unknown> = { name };
  if (obj['bypass_flags'] !== undefined) {
    const flags = filterClosedSetArray(obj['bypass_flags'], AI_CLI_BYPASS_FLAG_SET);
    if (flags !== null) out['bypass_flags'] = flags;
  }
  if (typeof obj['alt_home'] === 'boolean') out['alt_home'] = obj['alt_home'];
  if (typeof obj['headless'] === 'boolean') out['headless'] = obj['headless'];
  return out;
}

function isNonNegativeInt(v: unknown, max: number): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
}

function valueInBounds(v: unknown, depth: number, maxString: number, maxArray: number): boolean {
  if (v === null || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return v.length <= maxString;
  if (depth >= MAX_VALUE_DEPTH) return false;
  if (Array.isArray(v)) {
    if (v.length > maxArray) return false;
    return v.every((item) => valueInBounds(item, depth + 1, maxString, MAX_VALUE_ARRAY_ITEMS));
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length > MAX_VALUE_OBJECT_KEYS) return false;
    return entries.every(([k, item]) => k.length <= 128 && valueInBounds(item, depth + 1, maxString, MAX_VALUE_ARRAY_ITEMS));
  }
  return false;
}

const MAX_URL_INPUT_LEN = 65_536;

/** Reduce a URL to `scheme://host[:port]`, same rule as ingest's reduction. */
function reduceUrlToOrigin(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_URL_INPUT_LEN) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) return null;
  const host = u.host.toLowerCase();
  if (host.length === 0 || /[\s/?#@\\]/.test(host)) return null;
  const origin = `${scheme}://${host}`;
  return origin.length <= MAX_VALUE_STRING_LEN ? origin : null;
}

/** Same reduction as a `url` value, but allows a host-less scheme (`file:`). */
function reduceResourceUri(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_URL_INPUT_LEN) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  const scheme = u.protocol.replace(/:$/, '').toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) return null;
  const host = u.host.toLowerCase();
  if (host.length === 0 || /[\s/?#@\\]/.test(host)) return `${scheme}:`;
  const origin = `${scheme}://${host}`;
  return origin.length <= MAX_VALUE_STRING_LEN ? origin : `${scheme}:`;
}

/** Drop a path's query string and fragment, matching `path_redacted`'s promise. */
function redactPathQuery(path: string): string {
  const hash = path.indexOf('#');
  const noFrag = hash >= 0 ? path.slice(0, hash) : path;
  const q = noFrag.indexOf('?');
  if (q < 0) return noFrag;
  return `${noFrag.slice(0, q)}?<redacted>`;
}

export type SanitizedEventPayload =
  | { payload_withheld: false; payload: Record<string, unknown> }
  | { payload_withheld: true; payload: null };

/**
 * Re-sanitize a single event's `payload`. Unknown keys, and an allowlisted
 * key whose value fails its own closed-set/shape/boolean check, are dropped
 * individually (never named back to the caller). A non-negative-int counter
 * out of range, or any other allowlisted value exceeding its generic length/
 * depth/array bound, withholds the WHOLE payload (`payload_withheld: true`)
 * rather than storing a partial, possibly-misleading record -- the caller
 * keeps the event's own envelope fields (event_id, event_type,
 * timestamp_observed, tool_use_id) regardless.
 */
export function sanitizeEventPayloadForMcp(payload: unknown): SanitizedEventPayload {
  if (payload === null || payload === undefined || typeof payload !== 'object' || Array.isArray(payload)) {
    return { payload_withheld: false, payload: {} };
  }
  const input = payload as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [rawKey, v] of Object.entries(input)) {
    let k = rawKey;
    const canonical = TOKEN_COUNT_ALIASES.get(rawKey);
    if (canonical !== undefined && isTokenCount(v) && input[canonical] === undefined) {
      k = canonical;
    }
    if (!INGEST_PAYLOAD_KEYS.has(k)) continue; // unknown key: dropped, never counted back

    if (k === 'url') {
      const origin = reduceUrlToOrigin(v);
      if (origin !== null) out[k] = origin;
      continue;
    }
    if (k === 'path_redacted' && typeof v === 'string') {
      const redacted = redactPathQuery(v);
      if (redacted.length > MAX_VALUE_STRING_LEN) return { payload_withheld: true, payload: null };
      out[k] = redacted;
      continue;
    }
    if (k === 'also_ran') {
      if (isExecutableNameList(v)) out[k] = v;
      continue;
    }
    if (k === 'via') {
      if (isExecutableName(v)) out[k] = v;
      continue;
    }
    if (k === 'resources_seen') {
      if (!Array.isArray(v) || v.length > MAX_VALUE_ARRAY_ITEMS) continue;
      const list: string[] = [];
      for (const item of v) {
        const r = reduceResourceUri(item);
        if (r !== null) list.push(r);
      }
      out[k] = list;
      continue;
    }
    if (k === 'prompts_seen') {
      if (isSafeNameList(v)) out[k] = v;
      continue;
    }
    if (k === 'skill') {
      if (isSafeName(v)) out[k] = v;
      continue;
    }
    if (k === 'ai_cli') {
      const sanitized = sanitizeAiCli(v);
      if (sanitized !== null) out[k] = sanitized;
      continue;
    }

    const closedSet = CLOSED_SET_KEYS.get(k);
    if (closedSet !== undefined) {
      if (typeof v === 'string') {
        if (closedSet.has(v)) out[k] = v;
        continue;
      }
      const filtered = filterClosedSetArray(v, closedSet);
      if (filtered !== null) out[k] = filtered;
      continue;
    }
    if (HEX64_KEYS.has(k)) {
      if (typeof v === 'string' && HEX64_RE.test(v)) out[k] = v;
      continue;
    }
    if (HEX64_ARRAY_KEYS.has(k)) {
      if (Array.isArray(v) && v.length <= MAX_VALUE_ARRAY_ITEMS) {
        out[k] = v.filter((item): item is string => typeof item === 'string' && HEX64_RE.test(item));
      }
      continue;
    }
    if (HEX16_KEYS.has(k)) {
      if (typeof v === 'string' && HEX16_RE.test(v)) out[k] = v;
      continue;
    }
    if (SHA256_PREFIXED_KEYS.has(k)) {
      if (typeof v === 'string' && SHA256_PREFIXED_RE.test(v)) out[k] = v;
      continue;
    }
    if (HEX_REF_KEYS.has(k)) {
      if (typeof v === 'string' && HEX_REF_RE.test(v)) out[k] = v;
      continue;
    }
    if (BOOLEAN_KEYS.has(k)) {
      if (typeof v === 'boolean') out[k] = v;
      continue;
    }
    if (NONNEGATIVE_INT_KEYS.has(k)) {
      if (!isNonNegativeInt(v, NONNEGATIVE_INT_MAX.get(k) ?? Number.MAX_SAFE_INTEGER)) {
        return { payload_withheld: true, payload: null };
      }
      out[k] = v;
      continue;
    }

    const maxString = k === 'command' ? MAX_COMMAND_LEN : (VALUE_STRING_LEN_OVERRIDES.get(k) ?? MAX_VALUE_STRING_LEN);
    const maxArray = k === 'packages' ? MAX_PACKAGES_ITEMS : MAX_VALUE_ARRAY_ITEMS;
    if (!valueInBounds(v, 1, maxString, maxArray)) {
      return { payload_withheld: true, payload: null };
    }
    out[k] = v;
  }
  return { payload_withheld: false, payload: out };
}

/** Envelope fields kept even when the payload is withheld. */
export interface EventEnvelope {
  event_id: string;
  event_type: string;
  timestamp_observed: string;
  tool_use_id?: string | null;
}
