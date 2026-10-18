// ConfigChange: the tool_start-at-PreToolUse / tool_end / ConfigChange glue,
// mirroring vcs-push-plan.ts's async-compute / sync-apply split. The file
// read happens here, outside any lock; the session-state mutation (snapshot
// store, stash consumption) happens in the apply half, called from inside
// the same locked section every other plan uses.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HookEvent } from './normalize.js';
import type { SessionState } from './session-store.js';
import {
  ensureConfigSalt, storeConfigSnapshot, resolveConfigWriter,
  stashConfigWriteTool, stashConfigShellOpen, closeConfigShell,
  sweepStaleConfigStashes,
} from './session-store.js';
import {
  snapshotForSource, statusOnlySnapshot, diffConfigChanges, saltedContentHash,
  toFeaturePayload, type ConfigInternalSnapshot, type ConfigSource,
} from './config-snapshot.js';
import { WRITE_TOOLS } from './tool-shape.js';
import { classifyPath } from './shared/path-class-mirror.js';
import type { ToolShape } from './tool-shape.js';

/** Design doc 2.6: refuse anything over 1 MiB rather than read it. */
const MAX_CONFIG_FILE_BYTES = 1024 * 1024;

type ReadResult = { status: 'ok'; bytes: Buffer } | { status: 'absent' | 'too_large' | 'unreadable' };

/** lstat first; a symlink or non-regular file is `unreadable`, never followed. */
function readConfigFile(filePath: string): ReadResult {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(filePath);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { status: 'absent' } : { status: 'unreadable' };
  }
  if (st.isSymbolicLink() || !st.isFile()) return { status: 'unreadable' };
  if (st.size > MAX_CONFIG_FILE_BYTES) return { status: 'too_large' };
  try {
    return { status: 'ok', bytes: fs.readFileSync(filePath) };
  } catch {
    return { status: 'unreadable' };
  }
}

export type ConfigChangePlan =
  | { kind: 'none' }
  | { kind: 'change'; resolvedPath: string; configSource: ConfigSource; snapshot: ConfigInternalSnapshot; bytes: Buffer };

/**
 * The slow half: resolve the file the event names and read it. No session
 * state is touched here (plain file I/O only), same split vcs-push-plan.ts
 * uses for its subprocess call.
 */
export function computeConfigChangePlan(event: HookEvent, cwdFallback: string): ConfigChangePlan {
  if (event.kind !== 'config_change') return { kind: 'none' };
  const filePath = event.configFilePath;
  if (filePath === undefined) return { kind: 'none' };
  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(event.cwd ?? cwdFallback, filePath);
  const configSource = event.configSource ?? 'other';
  const read = readConfigFile(resolvedPath);
  const snapshot = read.status === 'ok' ? snapshotForSource(configSource, read.bytes) : statusOnlySnapshot(read.status);
  return { kind: 'change', resolvedPath, configSource, snapshot, bytes: read.status === 'ok' ? read.bytes : Buffer.alloc(0) };
}

/**
 * The sync half: compute the content hash with this session's salt, drop a
 * no-op reload, diff against the stored snapshot, resolve the writer and
 * append the config.changed shape to `event.configChangeShapes` (mirroring
 * `effectShapes`: appended, never replacing `event.shapes`). Replaces the
 * stored snapshot either way, so a dropped no-op still refreshes nothing
 * (its hash already matches) and a real change becomes the new baseline.
 */
export function applyConfigChangePlan(event: HookEvent, state: SessionState, plan: ConfigChangePlan, now: number): void {
  if (plan.kind === 'none') return;
  sweepStaleConfigStashes(state, now);

  const salt = ensureConfigSalt(state);
  const contentHash = saltedContentHash(salt, plan.bytes);
  const stored = state.configSnapshots?.[plan.resolvedPath];
  if (stored !== undefined && stored.contentHash === contentHash) return; // no-op reload: drop it entirely

  const labels = diffConfigChanges({ prev: stored?.snapshot, next: plan.snapshot });
  const writer = resolveConfigWriter(state, plan.resolvedPath, plan.configSource, labels, now);
  appendConfigChangedShape(event, plan, 'config_change', labels, writer);
  storeConfigSnapshot(state, plan.resolvedPath, plan.snapshot, contentHash, now);
}

function appendConfigChangedShape(
  event: HookEvent,
  plan: { configSource: ConfigSource; snapshot: ConfigInternalSnapshot },
  trigger: 'config_change' | 'session_start',
  configChanges: readonly string[],
  writer: string,
): void {
  const payload: Record<string, unknown> = {
    config_source: plan.configSource,
    trigger,
    ...toFeaturePayload(plan.snapshot),
    config_changes: [...configChanges],
    writer,
  };
  event.configChangeShapes = [...(event.configChangeShapes ?? []), { eventType: 'config.changed', payload }];
}

// ── SessionStart baseline (Claude Code only) ────────────────────────────────

/** Claude Code's enterprise-managed policy file, per OS (path-class-
 *  mirror.ts's own comment on the same three locations). Undefined on any
 *  other platform: left as a documented gap rather than guessed at. */
function managedSettingsPath(): string | undefined {
  if (process.platform === 'linux') return '/etc/claude-code/managed-settings.json';
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (process.platform === 'win32') return 'C:\\ProgramData\\ClaudeCode\\managed-settings.json';
  return undefined;
}

/** The up-to-four settings files SessionStart baselines. Skills are
 *  deliberately excluded (design doc 2.6): there is no fixed set of skill
 *  files to enumerate at session start the way there is for settings. */
function baselineCandidates(cwd: string, home: string): Array<{ source: ConfigSource; filePath: string }> {
  const managed = managedSettingsPath();
  const out: Array<{ source: ConfigSource; filePath: string }> = [
    { source: 'user_settings', filePath: path.join(home, '.claude', 'settings.json') },
    { source: 'project_settings', filePath: path.join(cwd, '.claude', 'settings.json') },
    { source: 'local_settings', filePath: path.join(cwd, '.claude', 'settings.local.json') },
  ];
  if (managed !== undefined) out.push({ source: 'policy_settings', filePath: managed });
  return out;
}

export type ConfigBaselinePlan = Array<{ resolvedPath: string; configSource: ConfigSource; snapshot: ConfigInternalSnapshot; bytes: Buffer }>;

/** The slow half for SessionStart: read each candidate file that exists.
 *  A file that does not exist is left out entirely, per design doc 2.6
 *  ("only for files that exist"); one that exists but cannot be read (too
 *  large, unreadable) is still reported, since its existence is itself
 *  evidence. */
export function computeConfigBaselinePlan(event: HookEvent, cwdFallback: string, home: string): ConfigBaselinePlan {
  if (event.kind !== 'session_start') return [];
  const cwd = event.cwd ?? cwdFallback;
  const out: ConfigBaselinePlan = [];
  for (const { source, filePath } of baselineCandidates(cwd, home)) {
    const read = readConfigFile(filePath);
    if (read.status === 'absent') continue;
    const snapshot = read.status === 'ok' ? snapshotForSource(source, read.bytes) : statusOnlySnapshot(read.status);
    out.push({ resolvedPath: filePath, configSource: source, snapshot, bytes: read.status === 'ok' ? read.bytes : Buffer.alloc(0) });
  }
  return out;
}

/** The sync half for SessionStart: no writer attribution (nothing wrote
 *  anything; this is the state found at the start), and no no-op short
 *  circuit (there is, by definition, no prior snapshot for this session
 *  yet). Still stores each snapshot, so the first real ConfigChange has a
 *  baseline to diff against instead of reading `prior_unknown`. */
export function applyConfigBaselinePlan(event: HookEvent, state: SessionState, plan: ConfigBaselinePlan, now: number): void {
  for (const entry of plan) {
    const salt = ensureConfigSalt(state);
    const contentHash = saltedContentHash(salt, entry.bytes);
    appendConfigChangedShape(event, entry, 'session_start', ['prior_unknown'], 'none_observed');
    storeConfigSnapshot(state, entry.resolvedPath, entry.snapshot, contentHash, now);
  }
}

// ── writer-attribution stashing at PreToolUse / tool_end ───────────────────

function resolvedPathOf(cwd: string | undefined, cwdFallback: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(cwd ?? cwdFallback, p);
}

/** Whether a write tool's target is worth stashing: a Claude settings file
 *  (classifyPath's agent_config) or a skills file (not yet in classifyPath;
 *  see path-class-mirror.ts's module header on that gap). */
function isConfigOrSkillPath(p: string): boolean {
  if (classifyPath(p) === 'agent_config') return true;
  const segments = p.split('/');
  return segments.includes('.claude') && segments.includes('skills') && (segments[segments.length - 1] ?? '') === 'SKILL.md';
}

/** Command-text substrings that mark a Bash call as naming a settings/skills
 *  path (design doc 2.4). The text itself is read once here and discarded;
 *  only the boolean survives. */
const SHELL_NAMED_MARKERS = ['.claude', 'settings.json', 'settings.local.json', 'managed-settings', 'SKILL.md'];

export function commandNamesConfigPath(command: string): boolean {
  return SHELL_NAMED_MARKERS.some((m) => command.includes(m));
}

/**
 * PreToolUse stashing, called for every tool_start regardless of harness
 * (a no-op for anything but Claude Code's write tools / Bash, since those
 * are the only shapes it looks for). `rawCommand` is read once, for the
 * `shell_named` test, and never stored; callers that have already discarded
 * it (every harness but Claude Code's own cli.ts path) pass undefined.
 */
export function stashConfigWriterOnToolStart(
  state: SessionState,
  tool: string | undefined,
  toolUseId: string | undefined,
  shapes: ToolShape[],
  cwd: string | undefined,
  cwdFallback: string,
  rawCommand: string | undefined,
  now: number,
): void {
  if (tool !== undefined && WRITE_TOOLS.has(tool)) {
    for (const shape of shapes) {
      if (shape.eventType !== 'file.written') continue;
      const p = shape.payload['path'];
      if (typeof p !== 'string') continue;
      const resolved = resolvedPathOf(cwd, cwdFallback, p);
      if (isConfigOrSkillPath(resolved)) stashConfigWriteTool(state, resolved, now);
    }
    return;
  }
  if (tool === 'Bash' && toolUseId !== undefined) {
    const named = rawCommand !== undefined && commandNamesConfigPath(rawCommand);
    stashConfigShellOpen(state, toolUseId, named, now);
  }
}

/** tool_end for a Bash call: no longer "still open", but the stash stays
 *  for the window-based shell_named/shell_unnamed fallback. */
export function closeConfigWriterOnToolEnd(state: SessionState, tool: string | undefined, toolUseId: string | undefined): void {
  if (tool === 'Bash' && toolUseId !== undefined) closeConfigShell(state, toolUseId);
}
