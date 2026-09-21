// Hook config writer - the security-sensitive part of aer-hooks.
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
import { existsSync, accessSync, statSync, constants as fsConstants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as os from 'node:os';

export type Harness = 'claude-code' | 'codex' | 'antigravity';

/** The command each AER hook entry runs. Marked so we can find + remove only ours. */
export const AER_HOOK_MARKER = 'aer-hook';

// Stop is a TURN boundary on both harnesses; SessionEnd is the run ending.
// Registering only Stop is what split one conversation across several records.
const LIFECYCLE_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'Stop', 'SubagentStart', 'SubagentStop', 'SessionEnd',
] as const;
const CLAUDE_EVENTS = LIFECYCLE_EVENTS;
const CODEX_EVENTS = LIFECYCLE_EVENTS;
// Antigravity has no SessionStart; PreInvocation stands in for it. Only the two
// tool events accept a matcher.
const ANTIGRAVITY_EVENTS = ['PreToolUse', 'PostToolUse', 'PreInvocation', 'PostInvocation', 'Stop'] as const;

// Claude Code gives ALL SessionEnd hooks 1.5s between them, and opening a
// session against the API takes 3-4s, so the entry that completes the record
// needs its own budget or it is killed before it finishes. Seconds, per the
// harness config. Codex caps its own SessionEnd at 3s whatever we ask, so it
// gets no key: an unrecognised one in its config buys nothing and risks the
// whole file.
const CLAUDE_SESSION_END_TIMEOUT_S = 15;
const ANTIGRAVITY_MATCHED = new Set<string>(['PreToolUse', 'PostToolUse']);
/** Our key in Antigravity's named-group root. We own it outright. */
const AER_GROUP_NAME = 'aer';

export interface InstallOptions {
  /** Base directory that stands in for the user home. Defaults to os.homedir(). */
  dir?: string | undefined;
}

interface HookCommandEntry {
  type: 'command';
  command: string;
  /** Per-hook budget in seconds, where the harness honours one. */
  timeout?: number;
}

interface HookMatcherGroup {
  matcher?: string;
  hooks: HookCommandEntry[];
}

type HooksMap = Record<string, HookMatcherGroup[]>;

// The command must resolve in the HARNESS's process, not the installer's.
// Under npx and npm exec the installer's PATH carries an ephemeral
// node_modules/.bin that the harness never sees, so a bare name found only
// there is written and then not found. Prefer the bare name only when it
// resolves on a persistent PATH dir, otherwise pin the absolute cli.js path.
function hookInvocation(): string {
  if (executableOnPersistentPath(AER_HOOK_MARKER)) return AER_HOOK_MARKER;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sibling = path.join(here, 'cli.js');
  if (existsSync(sibling) && isSafeToPin(sibling)) return `node ${shellSingleQuote(sibling)}`;
  return AER_HOOK_MARKER;
}

// Directories that exist only while a package manager runs a bin, so a command
// found only here will not resolve when the harness runs the hook.
function isEphemeralDir(dir: string): boolean {
  return dir.includes(`node_modules${path.sep}.bin`) || dir.includes(`${path.sep}_npx${path.sep}`);
}

function executableOnPersistentPath(cmd: string): boolean {
  const dirs = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  return dirs.some((d) => !isEphemeralDir(d) && isExecutableFile(path.join(d, cmd)));
}

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// POSIX single-quoting: everything inside '' is literal, and a literal quote is
// written by closing, escaping one, and reopening. Both harnesses run the
// command through sh, so this stops a path from being expanded or split.
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// Even single-quoted, refuse to pin a path that could still be dangerous or
// unrunnable: a control character or newline breaks the config line, and a
// path this hostile means something is already wrong. Fall back to the bare
// name rather than write it.
function isSafeToPin(p: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[\x00-\x1f\n]/.test(p);
}

/**
 * True when the command a wired entry runs still resolves to something the
 * harness could execute. Commands come from the user's own config file, so
 * this never throws on a hand-written or malformed one.
 */
export function hookCommandResolves(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.startsWith('node ')) {
    const arg = trimmed.slice('node '.length).split(' --harness')[0]?.trim() ?? '';
    // A quoted path, or a bare one a person typed by hand.
    let file = arg;
    if (arg.startsWith('"') || arg.startsWith("'")) {
      try { file = JSON.parse(arg.startsWith("'") ? `"${arg.slice(1, -1)}"` : arg) as string; }
      catch { file = arg.replace(/^['"]|['"]$/g, ''); }
    }
    return file.length > 0 && existsSync(file);
  }
  const first = trimmed.split(' ')[0] ?? '';
  // An absolute or relative path, versus a bare name to look up on PATH.
  if (first.includes(path.sep) || first.includes('/')) return isExecutableFile(first);
  return executableOnPersistentPath(first);
}

/**
 * The lifecycle the command was written for. The binary reads this to tell a
 * registration that knows SessionEnd from one written before it existed,
 * which still has to complete its record on Stop.
 */
const LIFECYCLE_FLAG = '--lifecycle v2';

function harnessCommand(harness: Harness, event?: string): string {
  const base = `${hookInvocation()} --harness ${harness} ${LIFECYCLE_FLAG}`;
  // Antigravity omits the event name from the payload, so each registration
  // has to carry it.
  return event === undefined ? base : `${base} --event ${event}`;
}

/** One Antigravity entry: the command sits on the entry itself. */
interface AntigravityEntry {
  matcher?: string;
  command: string;
}

/**
 * The hook group AER installs into an Antigravity config.
 *
 * Antigravity differs from the other two at both levels: named groups at the
 * root with no `hooks` wrapper, and the command directly on the entry. The
 * nested typed-object form the others use is rejected outright, with
 * `command hook must specify 'command'` in the CLI log and nothing loaded.
 */
function antigravityGroup(): Record<string, unknown> {
  const group: Record<string, unknown> = { enabled: true };
  for (const ev of ANTIGRAVITY_EVENTS) {
    const entry: AntigravityEntry = { command: harnessCommand('antigravity', ev) };
    if (ANTIGRAVITY_MATCHED.has(ev)) entry.matcher = '*';
    group[ev] = [entry];
  }
  return group;
}

/** Resolve the config file path for a harness under `base` (home or --dir). */
export function configPathFor(harness: Harness, base: string): string {
  if (harness === 'claude-code') return path.join(base, '.claude', 'settings.json');
  if (harness === 'antigravity') return path.join(base, '.gemini', 'config', 'hooks.json');
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

// Match only entries that run OUR hook binary, recognising both an older bare
// `aer-hook` and a path-pinned `node .../aer-hooks/dist/cli.js`, without
// matching a user's unrelated `node /somewhere/else/cli.js --harness` (which
// uninstall would otherwise delete and install would treat as already there).
function isAerEntry(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const cmd = (entry as Record<string, unknown>)['command'];
  if (typeof cmd !== 'string') return false;
  const c = cmd.trim();
  if (!c.includes('--harness')) return false;
  const first = c.split(' ')[0] ?? '';
  const base = first.split(/[\\/]/).pop() ?? '';
  if (base === AER_HOOK_MARKER) return true;
  // A pinned invocation: the node argument path ends at our built entry.
  const m = c.match(/aer-hooks[\\/](?:dist[\\/])?cli\.js/);
  return m !== null;
}

/**
 * Whether one entry in an event array is ours, in either layout: the nested
 * `hooks` array Claude Code and Codex use, or Antigravity's bare entry with
 * the command on it.
 */
function groupHasAer(group: HookMatcherGroup): boolean {
  if (isAerEntry(group)) return true;
  return Array.isArray(group.hooks) && group.hooks.some(isAerEntry);
}

/**
 * Add our entry, or bring an existing one up to date.
 *
 * Idempotence used to mean "an AER entry exists, leave it alone", which left
 * every upgraded user running the command an older release wrote. Our own
 * entries are rewritten; everybody else's are never touched.
 */
function mergeEvent(
  existing: unknown,
  command: string,
  timeout?: number,
): { groups: HookMatcherGroup[]; added: boolean; upgraded: boolean } {
  const groups: HookMatcherGroup[] = Array.isArray(existing)
    ? (existing as HookMatcherGroup[]).map((g) => ({ ...g, hooks: [...(g.hooks ?? [])] }))
    : [];

  let upgraded = false;
  for (const group of groups) {
    group.hooks = group.hooks.map((h) => {
      if (!isAerEntry(h)) return h;
      const want: HookCommandEntry = { type: 'command', command };
      if (timeout !== undefined) want.timeout = timeout;
      if (h.command === want.command && h.timeout === want.timeout) return h;
      upgraded = true;
      return want;
    });
  }
  if (groups.some(groupHasAer)) return { groups, added: false, upgraded };

  const entry: HookCommandEntry = { type: 'command', command };
  if (timeout !== undefined) entry.timeout = timeout;
  groups.push({ matcher: '*', hooks: [entry] });
  return { groups, added: true, upgraded: false };
}

export interface InstallResult {
  harness: Harness;
  path: string;
  backupPath: string | null;
  added: string[];
  alreadyPresent: string[];
  /** Events whose existing AER entry was brought up to date. */
  upgraded: string[];
}

/** Wire AER hooks into the harness config. Conservative read-modify-write. */
export async function install(harness: Harness, opts: InstallOptions = {}): Promise<InstallResult> {
  const base = baseDir(opts);
  const file = configPathFor(harness, base);
  const config = await readJsonOrAbort(file);
  if (harness === 'antigravity') return installAntigravity(file, config);

  const existingHooks =
    typeof config['hooks'] === 'object' && config['hooks'] !== null && !Array.isArray(config['hooks'])
      ? ({ ...(config['hooks'] as Record<string, unknown>) } as HooksMap)
      : ({} as HooksMap);

  const command = harnessCommand(harness);
  const events = harness === 'claude-code' ? CLAUDE_EVENTS : CODEX_EVENTS;
  const added: string[] = [];
  const alreadyPresent: string[] = [];
  const upgraded: string[] = [];

  for (const ev of events) {
    const timeout = harness === 'claude-code' && ev === 'SessionEnd' ? CLAUDE_SESSION_END_TIMEOUT_S : undefined;
    const { groups, added: didAdd, upgraded: didUpgrade } = mergeEvent(existingHooks[ev], command, timeout);
    existingHooks[ev] = groups;
    if (didAdd) added.push(ev);
    else alreadyPresent.push(ev);
    if (didUpgrade) upgraded.push(ev);
  }

  // Nothing to do: do not rewrite the file or create a backup.
  if (added.length === 0 && upgraded.length === 0) {
    return { harness, path: file, backupPath: null, added, alreadyPresent, upgraded };
  }

  const next = { ...config, hooks: existingHooks };
  const backupPath = await writeWithBackup(file, next);
  return { harness, path: file, backupPath, added, alreadyPresent, upgraded };
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

/**
 * Antigravity's root is a map of named hook groups with no `hooks` wrapper, so
 * AER owns one key and leaves every other group alone. Replacing our own group
 * wholesale is safe precisely because it is ours.
 */
async function installAntigravity(
  file: string,
  config: Record<string, unknown>,
): Promise<InstallResult> {
  const want = antigravityGroup();
  if (JSON.stringify(config[AER_GROUP_NAME]) === JSON.stringify(want)) {
    return {
      harness: 'antigravity',
      path: file,
      backupPath: null,
      added: [],
      alreadyPresent: [...ANTIGRAVITY_EVENTS],
      upgraded: [],
    };
  }

  const backupPath = await writeWithBackup(file, { ...config, [AER_GROUP_NAME]: want });
  return {
    harness: 'antigravity',
    path: file,
    backupPath,
    added: [...ANTIGRAVITY_EVENTS],
    alreadyPresent: [],
    // AER owns its whole group here, so a rewrite is always the current one.
    upgraded: [],
  };
}

/** Remove only AER's hook entries. Leaves every other hook intact. */
export async function uninstall(harness: Harness, opts: InstallOptions = {}): Promise<UninstallResult> {
  const base = baseDir(opts);
  const file = configPathFor(harness, base);
  const config = await readJsonOrAbort(file);

  if (harness === 'antigravity') {
    if (config[AER_GROUP_NAME] === undefined) {
      return { harness, path: file, backupPath: null, removed: [] };
    }
    const next = { ...config };
    delete next[AER_GROUP_NAME];
    const backupPath = await writeWithBackup(file, next);
    return { harness, path: file, backupPath, removed: [...ANTIGRAVITY_EVENTS] };
  }

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
  // Whether the command every wired entry runs still resolves to a binary. A
  // wired hook whose command cannot be found records nothing and reads to the
  // user as AER silently not working, which is the failure worth surfacing.
  resolves: boolean;
}

/** Report which events currently carry an AER hook entry, per harness. */
export async function status(opts: InstallOptions = {}): Promise<StatusEntry[]> {
  const base = baseDir(opts);
  const out: StatusEntry[] = [];
  for (const harness of ['claude-code', 'codex', 'antigravity'] as const) {
    const file = configPathFor(harness, base);
    let exists = false;
    let wiredEvents: string[] = [];
    let resolves = true;
    try {
      await fs.access(file);
      exists = true;
    } catch {
      out.push({ harness, path: file, exists: false, wiredEvents, resolves: true });
      continue;
    }
    try {
      const config = await readJsonOrAbort(file);
      // Antigravity's groups sit at the root under our own key, with no wrapper.
      const hooks = harness === 'antigravity' ? config[AER_GROUP_NAME] : config['hooks'];
      if (typeof hooks === 'object' && hooks !== null && !Array.isArray(hooks)) {
        const commands: string[] = [];
        for (const [ev, groups] of Object.entries(hooks as HooksMap)) {
          if (!Array.isArray(groups) || !groups.some(groupHasAer)) continue;
          wiredEvents.push(ev);
          for (const g of groups) {
            for (const h of g.hooks ?? []) {
              if (isAerEntry(h)) commands.push((h as HookCommandEntry).command.trim());
            }
          }
        }
        resolves = commands.length === 0 || commands.every(hookCommandResolves);
      }
    } catch {
      // Malformed config: the file exists but yields no readable AER wiring.
      wiredEvents = [];
    }
    out.push({ harness, path: file, exists, wiredEvents, resolves });
  }
  return out;
}
