// Pure feature snapshot + delta for a Claude Code settings file.
//
// Bytes in, closed-set labels and bounded counts out. No file I/O, no
// network, nothing async: the caller does the lstat/read/size-cap and hands
// the resulting bytes here.

import { createHash } from 'node:crypto';
import { INTERPRETER_INLINE_FLAGS } from './shell-line.js';

export const CONFIG_SOURCES = ['user_settings', 'project_settings', 'local_settings', 'policy_settings', 'skills', 'other'] as const;
export type ConfigSource = (typeof CONFIG_SOURCES)[number];

export const CONFIG_STATUSES = ['ok', 'absent', 'unparseable', 'too_large', 'unreadable', 'not_parsed'] as const;
export type ConfigStatus = (typeof CONFIG_STATUSES)[number];

export const DEFAULT_MODES = ['plan', 'dontAsk', 'default', 'auto', 'acceptEdits', 'bypassPermissions', 'unset', 'other'] as const;
export type DefaultMode = (typeof DEFAULT_MODES)[number];

export const CONFIG_CHANGE_LABELS = [
  // Elevating
  'deny_removed', 'ask_removed', 'allow_broadened', 'default_mode_loosened',
  'bypass_guard_removed', 'dirs_added', 'mcp_auto_enabled', 'sandbox_disabled',
  'hooks_disabled_on', 'aer_hooks_removed',
  // Neutral or narrowing
  'allow_added', 'allow_removed', 'deny_added', 'hooks_added', 'hooks_removed',
  'default_mode_tightened', 'content_only',
  // Lifecycle
  'file_created', 'file_deleted', 'prior_unknown',
] as const;
export type ConfigChangeLabel = (typeof CONFIG_CHANGE_LABELS)[number];

/** Caps mirrored from the server schema (NONNEGATIVE_INT_MAX for these keys). */
export const MAX_RULE_COUNT = 4096;
export const MAX_AER_HOOK_COUNT = 256;
/** Caps mirrored from the server's CLOSED_SET_ARRAY_MAX for config_changes. */
export const MAX_CONFIG_CHANGES = 16;

/** The collector's own hook command marker (install.ts's AER_HOOK_MARKER).
 *  Duplicated rather than imported: install.ts pulls in fs/path/os for its
 *  own purposes, and this module must stay free of any import that is not
 *  itself pure. */
const AER_HOOK_MARKER = 'aer-hook';

/** The wire-sent feature snapshot: closed-set labels, counts and a boolean. */
export interface ConfigFeatureSnapshot {
  config_status: ConfigStatus;
  allow_rules: number;
  deny_rules: number;
  broad_allow_rules: number;
  default_mode: DefaultMode;
  hooks_disabled: boolean;
  aer_hook_count: number;
}

/**
 * The full local state session-store.ts keeps per file, across invocations,
 * so a delta can be computed next time. Everything past the wire-sent
 * feature snapshot stays on disk, owner-only, and is never put on an emitted
 * payload: effectStash/vcsPushStash already keep local-only paths and
 * command text the same way.
 */
export interface ConfigInternalSnapshot extends ConfigFeatureSnapshot {
  allowRulesRaw: string[];
  denyRulesRaw: string[];
  askRulesRaw: string[];
  nonAerHookCount: number;
  bypassGuardOn: boolean;
  additionalDirectoriesRaw: string[];
  mcpAutoEnabled: boolean;
  sandboxDisabled: boolean;
}

function zeroedInternal(status: ConfigStatus): ConfigInternalSnapshot {
  return {
    config_status: status,
    allow_rules: 0, deny_rules: 0, broad_allow_rules: 0,
    default_mode: 'unset', hooks_disabled: false, aer_hook_count: 0,
    allowRulesRaw: [], denyRulesRaw: [], askRulesRaw: [],
    nonAerHookCount: 0, bypassGuardOn: false, additionalDirectoriesRaw: [],
    mcpAutoEnabled: false, sandboxDisabled: false,
  };
}

/** A snapshot for a `config_status` the caller already determined without
 *  reading any bytes at all (the file is absent, too large to read, or not
 *  a regular file). The internal fields all read as empty/false/0. */
export function statusOnlySnapshot(status: Exclude<ConfigStatus, 'ok' | 'unparseable' | 'not_parsed'>): ConfigInternalSnapshot {
  return zeroedInternal(status);
}

const MODE_MAP: ReadonlySet<DefaultMode> = new Set(['plan', 'dontAsk', 'default', 'auto', 'acceptEdits', 'bypassPermissions']);

function modeOf(v: unknown): DefaultMode {
  if (v === undefined) return 'unset';
  return typeof v === 'string' && MODE_MAP.has(v as DefaultMode) ? (v as DefaultMode) : 'other';
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function stringArray(v: unknown, cap: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string') out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}

const BARE_TOOL_RE = /^[A-Za-z][A-Za-z0-9]*$/;
const TOOL_WILDCARD_RE = /^[A-Za-z][A-Za-z0-9]*\((?:\*|:\*|\*\*)\)$/;
const BASH_INTERPRETER_RE = /^Bash\(([A-Za-z0-9._+-]+):\*\)$/;

/**
 * Whether one `permissions.allow` rule grants a whole tool (or a whole MCP
 * server), rather than one narrow invocation of it: a bare tool name,
 * `Tool(*)` / `Tool(:*)` / `Tool(**)`, `mcp__*`, a whole `mcp__<server>`
 * with no trailing `__<tool>`, or `Bash(<interpreter>:*)` for an
 * interpreter shell-line.ts already treats as one (its own inline-eval
 * flags map, reused here rather than duplicated).
 */
export function isBroadAllowRule(rule: string): boolean {
  const r = rule.trim();
  if (r.length === 0) return false;
  if (r === 'mcp__*') return true;
  if (BARE_TOOL_RE.test(r)) return true;
  if (TOOL_WILDCARD_RE.test(r)) return true;
  // mcp__<server> with no further `__<tool>` suffix grants the whole server;
  // a second `__` names one specific tool on it, which is narrow.
  if (r.startsWith('mcp__')) {
    const afterPrefix = r.slice('mcp__'.length);
    if (afterPrefix.length > 0 && !afterPrefix.includes('__')) return true;
  }
  const bashInterp = BASH_INTERPRETER_RE.exec(r);
  if (bashInterp !== null) return INTERPRETER_INLINE_FLAGS.has(bashInterp[1]!);
  return false;
}

function countAerHooks(hooks: unknown): { aer: number; nonAer: number } {
  const rec = asRecord(hooks);
  if (rec === undefined) return { aer: 0, nonAer: 0 };
  let aer = 0;
  let nonAer = 0;
  for (const groups of Object.values(rec)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const g = asRecord(group);
      const entries = Array.isArray(g?.['hooks']) ? (g!['hooks'] as unknown[]) : [];
      for (const entry of entries) {
        const command = asRecord(entry)?.['command'];
        if (typeof command !== 'string') continue;
        if (command.includes(AER_HOOK_MARKER)) aer += 1;
        else nonAer += 1;
      }
    }
  }
  return { aer: Math.min(aer, MAX_AER_HOOK_COUNT), nonAer };
}

/** Feature extraction over an already-parsed settings object. Every field is
 *  read defensively: the wrong type for a field reads the same as absent. */
function featuresOf(settings: Record<string, unknown>): ConfigInternalSnapshot {
  const permissions = asRecord(settings['permissions']) ?? {};
  const allowRulesRaw = stringArray(permissions['allow'], MAX_RULE_COUNT);
  const denyRulesRaw = stringArray(permissions['deny'], MAX_RULE_COUNT);
  const askRulesRaw = stringArray(permissions['ask'], MAX_RULE_COUNT);
  const additionalDirectoriesRaw = stringArray(permissions['additionalDirectories'], MAX_RULE_COUNT);
  const broadAllowCount = Math.min(allowRulesRaw.filter(isBroadAllowRule).length, MAX_RULE_COUNT);
  const { aer: aerHookCount, nonAer: nonAerHookCount } = countAerHooks(settings['hooks']);

  return {
    config_status: 'ok',
    allow_rules: Math.min(allowRulesRaw.length, MAX_RULE_COUNT),
    deny_rules: Math.min(denyRulesRaw.length, MAX_RULE_COUNT),
    broad_allow_rules: broadAllowCount,
    default_mode: modeOf(permissions['defaultMode']),
    hooks_disabled: settings['disableAllHooks'] === true,
    aer_hook_count: aerHookCount,
    allowRulesRaw, denyRulesRaw, askRulesRaw,
    nonAerHookCount,
    bypassGuardOn: permissions['disableBypassPermissionsMode'] === true,
    additionalDirectoriesRaw,
    mcpAutoEnabled: settings['enableAllProjectMcpServers'] === true,
    // The exact settings field for a sandbox toggle is not confirmed against
    // a live build (design-doc risk: field-name drift); this is the best
    // documented guess (`sandbox.enabled === false`) and is flagged here so
    // it is easy to find and correct once verified.
    sandboxDisabled: asRecord(settings['sandbox'])?.['enabled'] === false,
  };
}

/**
 * Parse settings bytes already known to exist, be a regular file and be at
 * or under the size cap: `source: 'skills'` has no feature snapshot
 * (`not_parsed`); anything else is JSON.parse'd, a non-object or malformed
 * result reading as `unparseable`.
 */
export function snapshotForSource(source: ConfigSource, bytes: Uint8Array): ConfigInternalSnapshot {
  if (source === 'skills') return zeroedInternal('not_parsed');
  let text: string;
  try {
    text = Buffer.from(bytes).toString('utf8');
  } catch {
    return zeroedInternal('unparseable');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return zeroedInternal('unparseable');
  }
  const rec = asRecord(parsed);
  if (rec === undefined) return zeroedInternal('unparseable');
  return featuresOf(rec);
}

/** A salted content digest: sha256(salt || bytes), hex. The salt is random
 *  per session and supplied by the caller (session-store.ts owns session
 *  state); this module never generates or stores it. */
export function saltedContentHash(salt: string, bytes: Uint8Array): string {
  return createHash('sha256').update(salt, 'utf8').update(bytes).digest('hex');
}

const MODE_RANK: Partial<Record<DefaultMode, number>> = {
  plan: 0, dontAsk: 0, default: 1, auto: 2, acceptEdits: 2, bypassPermissions: 3,
};

export interface DiffInput {
  prev: ConfigInternalSnapshot | undefined;
  next: ConfigInternalSnapshot;
}

/**
 * The `config_changes` labels for a settings file whose content hash has
 * already been found to differ from the stored one (callers must drop a
 * same-hash reload before ever reaching this: see the module header and
 * session-store.ts's snapshot store). `prev === undefined` means no stored
 * snapshot at all for this resolved path, which is `prior_unknown` on its
 * own, not combined with the rest of the diff.
 */
export function diffConfigChanges({ prev, next }: DiffInput): ConfigChangeLabel[] {
  if (prev === undefined) return ['prior_unknown'];

  const labels: ConfigChangeLabel[] = [];
  const wasAbsent = prev.config_status === 'absent';
  const nowAbsent = next.config_status === 'absent';
  if (wasAbsent && !nowAbsent) labels.push('file_created');
  if (!wasAbsent && nowAbsent) labels.push('file_deleted');

  // Feature deltas only make sense when both snapshots actually parsed. They
  // are compared by COUNT, not by raw rule identity: a narrow rule swapped
  // for another of the same class moves no count and falls through to
  // content_only below, per the design's "no tracked feature moved" rule.
  if (!wasAbsent && !nowAbsent && prev.config_status === 'ok' && next.config_status === 'ok') {
    const askCountPrev = prev.askRulesRaw.length;
    const askCountNext = next.askRulesRaw.length;
    const dirsCountPrev = prev.additionalDirectoriesRaw.length;
    const dirsCountNext = next.additionalDirectoriesRaw.length;

    if (next.broad_allow_rules > prev.broad_allow_rules) labels.push('allow_broadened');
    else if (next.allow_rules > prev.allow_rules) labels.push('allow_added');
    if (next.allow_rules < prev.allow_rules && next.broad_allow_rules <= prev.broad_allow_rules) labels.push('allow_removed');

    if (next.deny_rules < prev.deny_rules) labels.push('deny_removed');
    if (next.deny_rules > prev.deny_rules) labels.push('deny_added');

    if (askCountNext < askCountPrev) labels.push('ask_removed');

    if (dirsCountNext > dirsCountPrev) labels.push('dirs_added');

    if (prev.bypassGuardOn && !next.bypassGuardOn) labels.push('bypass_guard_removed');
    if (!prev.mcpAutoEnabled && next.mcpAutoEnabled) labels.push('mcp_auto_enabled');
    if (!prev.sandboxDisabled && next.sandboxDisabled) labels.push('sandbox_disabled');

    const prevRank = MODE_RANK[prev.default_mode];
    const nextRank = MODE_RANK[next.default_mode];
    if (prevRank !== undefined && nextRank !== undefined) {
      if (nextRank > prevRank) labels.push('default_mode_loosened');
      else if (nextRank < prevRank) labels.push('default_mode_tightened');
    }

    if (!prev.hooks_disabled && next.hooks_disabled) labels.push('hooks_disabled_on');
    if (prev.aer_hook_count > 0 && next.aer_hook_count === 0) labels.push('aer_hooks_removed');
    if (next.nonAerHookCount > prev.nonAerHookCount) labels.push('hooks_added');
    if (next.nonAerHookCount < prev.nonAerHookCount) labels.push('hooks_removed');
  }

  if (labels.length === 0) labels.push('content_only');
  return labels.slice(0, MAX_CONFIG_CHANGES);
}

/** The wire-safe subset of an internal snapshot, for the config.changed payload. */
export function toFeaturePayload(s: ConfigFeatureSnapshot): ConfigFeatureSnapshot {
  return {
    config_status: s.config_status,
    allow_rules: s.allow_rules,
    deny_rules: s.deny_rules,
    broad_allow_rules: s.broad_allow_rules,
    default_mode: s.default_mode,
    hooks_disabled: s.hooks_disabled,
    aer_hook_count: s.aer_hook_count,
  };
}
