// Hook config writer — the security-sensitive part of aer-hooks.
//
// `install` wires the AER hook into a harness config so PreToolUse / PostToolUse /
// SessionStart / Stop run `aer-hook --harness <name>`. It is conservative by design:
//   - Read-modify-write. Never overwrite a config wholesale.
//   - Back up the existing file to <file>.bak before writing.
//   - Parse-or-abort. If the existing JSON is malformed, abort rather than clobber.
//   - Idempotent. Re-running adds no duplicate AER entries.
//   - Only AER's own entries are added; `uninstall` removes only AER's entries.
//   - Paths resolve under the user home or an explicit --dir, never elsewhere.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export type Harness = 'claude-code' | 'codex';

/** The command each AER hook entry runs. Marked so we can find + remove only ours. */
export const AER_HOOK_MARKER = 'aer-hook';

const CLAUDE_EVENTS = ['PreToolUse', 'PostToolUse', 'SessionStart', 'Stop'] as const;
const CODEX_EVENTS = ['PreToolUse', 'PostToolUse', 'SessionStart', 'Stop'] as const;

export interface InstallOptions {
  /** Base directory that stands in for the user home. Defaults to os.homedir(). */
  dir?: string | undefined;
}

interface HookCommandEntry {
  type: 'command';
  command: string;
}

interface HookMatcherGroup {
  matcher?: string;
  hooks: HookCommandEntry[];
}

type HooksMap = Record<string, HookMatcherGroup[]>;

function harnessCommand(harness: Harness): string {
  return `${AER_HOOK_MARKER} --harness ${harness}`;
}

/** Resolve the config file path for a harness under `base` (home or --dir). */
export function configPathFor(harness: Harness, base: string): string {
  if (harness === 'claude-code') return path.join(base, '.claude', 'settings.json');
  return path.join(base, '.codex', 'hooks.json');
}

function baseDir(opts: InstallOptions): string {
  return opts.dir ?? os.homedir();
}

async function readJsonOrAbort(file: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('config root is not a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `refusing to modify ${file}: existing JSON is malformed (${msg}). ` +
        `Fix or remove the file, then re-run.`,
    );
  }
}

// Match ONLY the exact commands we install, so an unrelated user hook that
// merely mentions "aer-hook" is never touched by idempotency or uninstall.
const AER_COMMANDS = new Set<string>([harnessCommand('claude-code'), harnessCommand('codex')]);

function isAerEntry(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const cmd = (entry as Record<string, unknown>)['command'];
  return typeof cmd === 'string' && AER_COMMANDS.has(cmd.trim());
}

function groupHasAer(group: HookMatcherGroup): boolean {
  return Array.isArray(group.hooks) && group.hooks.some(isAerEntry);
}

/** Merge AER's command into one event array without clobbering existing entries. */
function mergeEvent(existing: unknown, command: string): { groups: HookMatcherGroup[]; added: boolean } {
  const groups: HookMatcherGroup[] = Array.isArray(existing)
    ? (existing as HookMatcherGroup[]).map((g) => ({ ...g }))
    : [];
  // Idempotent: if any group already carries an AER entry, do nothing.
  if (groups.some(groupHasAer)) return { groups, added: false };
  groups.push({ matcher: '*', hooks: [{ type: 'command', command }] });
  return { groups, added: true };
}

export interface InstallResult {
  harness: Harness;
  path: string;
  backupPath: string | null;
  added: string[];
  alreadyPresent: string[];
}

/** Wire AER hooks into the harness config. Conservative read-modify-write. */
export async function install(harness: Harness, opts: InstallOptions = {}): Promise<InstallResult> {
  const base = baseDir(opts);
  const file = configPathFor(harness, base);
  const config = await readJsonOrAbort(file);

  const existingHooks =
    typeof config['hooks'] === 'object' && config['hooks'] !== null && !Array.isArray(config['hooks'])
      ? ({ ...(config['hooks'] as Record<string, unknown>) } as HooksMap)
      : ({} as HooksMap);

  const command = harnessCommand(harness);
  const events = harness === 'claude-code' ? CLAUDE_EVENTS : CODEX_EVENTS;
  const added: string[] = [];
  const alreadyPresent: string[] = [];

  for (const ev of events) {
    const { groups, added: didAdd } = mergeEvent(existingHooks[ev], command);
    existingHooks[ev] = groups;
    if (didAdd) added.push(ev);
    else alreadyPresent.push(ev);
  }

  // Nothing to do: do not rewrite the file or create a backup.
  if (added.length === 0) {
    return { harness, path: file, backupPath: null, added, alreadyPresent };
  }

  const next = { ...config, hooks: existingHooks };
  const backupPath = await writeWithBackup(file, next);
  return { harness, path: file, backupPath, added, alreadyPresent };
}

/**
 * Refuse to write through a symlinked config file or config directory. A
 * symlinked target could redirect the write to an attacker-chosen path, so we
 * abort rather than follow it. Missing file/dir is fine (we create them).
 */
async function assertNoSymlink(file: string): Promise<void> {
  const dir = path.dirname(file);
  for (const p of [dir, file]) {
    try {
      const st = await fs.lstat(p);
      if (st.isSymbolicLink()) {
        throw new Error(`refusing to write ${file}: ${p} is a symlink`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
  }
}

async function writeWithBackup(file: string, data: unknown): Promise<string | null> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await assertNoSymlink(file);

  // Preserve the existing config's mode; default owner-only for a file we create.
  let mode = 0o600;
  let backupPath: string | null = null;
  try {
    const current = await fs.readFile(file, 'utf8');
    mode = (await fs.stat(file)).mode & 0o777;
    backupPath = `${file}.bak`;
    await fs.writeFile(backupPath, current, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // No existing file: nothing to back up, keep the conservative default mode.
  }

  // Atomic: write a sibling temp then rename over the target, so a crash mid-write
  // can never truncate or corrupt the user's config.
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode });
  await fs.rename(tmp, file);
  return backupPath;
}

export interface UninstallResult {
  harness: Harness;
  path: string;
  backupPath: string | null;
  removed: string[];
}

/** Remove only AER's hook entries. Leaves every other hook intact. */
export async function uninstall(harness: Harness, opts: InstallOptions = {}): Promise<UninstallResult> {
  const base = baseDir(opts);
  const file = configPathFor(harness, base);
  const config = await readJsonOrAbort(file);

  const hooks =
    typeof config['hooks'] === 'object' && config['hooks'] !== null && !Array.isArray(config['hooks'])
      ? ({ ...(config['hooks'] as Record<string, unknown>) } as HooksMap)
      : ({} as HooksMap);

  const removed: string[] = [];
  for (const [ev, rawGroups] of Object.entries(hooks)) {
    if (!Array.isArray(rawGroups)) continue;
    let changed = false;
    const groups: HookMatcherGroup[] = [];
    for (const g of rawGroups as HookMatcherGroup[]) {
      if (!g || !Array.isArray(g.hooks)) {
        groups.push(g);
        continue;
      }
      const keptHooks = g.hooks.filter((h) => !isAerEntry(h));
      if (keptHooks.length !== g.hooks.length) changed = true;
      // Drop groups that become empty only because we removed AER's entry.
      if (keptHooks.length > 0) groups.push({ ...g, hooks: keptHooks });
    }
    if (changed) removed.push(ev);
    if (groups.length > 0) hooks[ev] = groups;
    else delete hooks[ev];
  }

  if (removed.length === 0) {
    return { harness, path: file, backupPath: null, removed };
  }

  const next: Record<string, unknown> = { ...config };
  if (Object.keys(hooks).length > 0) next['hooks'] = hooks;
  else delete next['hooks'];
  const backupPath = await writeWithBackup(file, next);
  return { harness, path: file, backupPath, removed };
}

export interface StatusEntry {
  harness: Harness;
  path: string;
  exists: boolean;
  wiredEvents: string[];
}

/** Report which events currently carry an AER hook entry, per harness. */
export async function status(opts: InstallOptions = {}): Promise<StatusEntry[]> {
  const base = baseDir(opts);
  const out: StatusEntry[] = [];
  for (const harness of ['claude-code', 'codex'] as const) {
    const file = configPathFor(harness, base);
    let exists = false;
    let wiredEvents: string[] = [];
    try {
      await fs.access(file);
      exists = true;
    } catch {
      out.push({ harness, path: file, exists: false, wiredEvents });
      continue;
    }
    try {
      const config = await readJsonOrAbort(file);
      const hooks = config['hooks'];
      if (typeof hooks === 'object' && hooks !== null && !Array.isArray(hooks)) {
        wiredEvents = Object.entries(hooks as HooksMap)
          .filter(([, groups]) => Array.isArray(groups) && groups.some(groupHasAer))
          .map(([ev]) => ev);
      }
    } catch {
      // Malformed config: the file exists but yields no readable AER wiring.
      wiredEvents = [];
    }
    out.push({ harness, path: file, exists, wiredEvents });
  }
  return out;
}
