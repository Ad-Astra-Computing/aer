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

// Claude Code gives ALL SessionEnd hooks 1.5s between them, and opening or
// completing a session against the API takes 3-4s, so the entries that open
// and close the record need their own budget or they are killed before they
// finish. Seconds, per the harness config. Codex caps its own SessionEnd at
// 3s whatever we ask, so it gets no key: an unrecognised one in its config
// buys nothing and risks the whole file.
const CLAUDE_HEADROOM_TIMEOUT_S = 15;
const ANTIGRAVITY_MATCHED = new Set<string>(['PreToolUse', 'PostToolUse']);
/** Our key in Antigravity's named-group root. We own it outright. */
const AER_GROUP_NAME = 'aer';

export interface InstallOptions {
  /** Base directory that stands in for the user home. Defaults to os.homedir(). */
  dir?: string | undefined;
  /**
   * An owner-only file holding the AER credentials, read by the hook process
   * alone. Written into every command as `--env-file`, so the key never has
   * to be exported in the shell the harness and its agent run in. When
   * omitted, a file an earlier install wrote is kept.
   */
  envFile?: string | undefined;
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

// Root-session join (ADR-023 B1) needs no flag: the shell substitution was
// found empty against Claude Code 2.1.281, so cli.ts reads the harness's
// own CLAUDE_CODE_SESSION_ID env var instead. --root-session still exists
// as an explicit override for a caller that sets it itself.
function harnessCommand(harness: Harness, event?: string, envFile?: string, endBudgetMs?: number): string {
  let cmd = `${hookInvocation()} --harness ${harness} ${LIFECYCLE_FLAG}`;
  // Antigravity omits the event name from the payload, so each registration
  // has to carry it.
  if (event !== undefined) cmd += ` --event ${event}`;
  if (envFile !== undefined) cmd += ` --env-file ${shellSingleQuote(envFile)}`;
  if (endBudgetMs !== undefined) cmd += ` --end-budget-ms ${endBudgetMs}`;
  return cmd;
}

/**
 * How long the harness lets the entry that ends a session run, in ms, with a
 * margin, when that is known: the timeout this installer sets on Claude
 * Code's SessionEnd, Codex's fixed 3 s cap, Antigravity's 30 s default on the
 * Stop that ends its sessions. The hook delivers inline for that long, so a
 * record completes even where its background worker dies with the harness.
 */
function endBudgetMs(harness: Harness, event: string): number | undefined {
  if (harness === 'claude-code' && event === 'SessionEnd') return CLAUDE_HEADROOM_TIMEOUT_S * 1000 - 1500;
  if (harness === 'codex' && event === 'SessionEnd') return 2500;
  if (harness === 'antigravity' && event === 'Stop') return 25_000;
  return undefined;
}

const ENV_FILE_IN_COMMAND = / --env-file '((?:[^']|'\\'')*)'/;

/** The credential file an existing AER entry in this config already names, if any. */
function existingEnvFile(config: unknown): string | undefined {
  const text = JSON.stringify(config ?? {});
  for (const cmd of text.match(/"command":"(?:[^"\\]|\\.)*"/g) ?? []) {
    const command = JSON.parse(cmd.slice('"command":'.length)) as string;
    if (!isAerEntry({ command })) continue;
    const m = ENV_FILE_IN_COMMAND.exec(command);
    if (m) return m[1]!.replace(/'\\''/g, "'");
  }
  return undefined;
}

/**
 * The hook group AER installs into an Antigravity config.
 *
 * Antigravity has named groups at the root with no `hooks` wrapper, and two
 * kinds of entry inside one. The tool events take a matcher group with the
 * command in a nested `hooks` array, as Claude Code does; the invocation
 * events and Stop take the command directly on the entry. Each form is wrong
 * for the other kind: a nested invocation entry is rejected with `command
 * hook must specify 'command'` and none of the group loads, and a flat tool
 * entry loads and never fires. Both seen against agy 1.2.6.
 */
function antigravityGroup(envFile?: string): Record<string, unknown> {
  const group: Record<string, unknown> = { enabled: true };
  for (const ev of ANTIGRAVITY_EVENTS) {
    const command = harnessCommand('antigravity', ev, envFile, endBudgetMs('antigravity', ev));
    group[ev] = ANTIGRAVITY_MATCHED.has(ev)
      ? [{ matcher: '*', hooks: [{ type: 'command', command }] }]
      : [{ command }];
  }
  return group;
}

/**
 * A warning when AER is wired in more than one config layer, or nothing.
 *
 * Every matching layer loads: a project config does not replace the home one,
 * it runs alongside it. Two registrations mean every event is recorded twice
 * and the run is split across records, and nothing in either config says so.
 */
export async function duplicateLayerWarning(
  harness: Harness,
  base: string,
  projectDir: string | undefined,
): Promise<string | undefined> {
  if (projectDir === undefined || projectDir.length === 0) return undefined;
  const project = path.resolve(projectDir);
  if (project === path.resolve(base)) return undefined;

  const wiredIn = async (dir: string): Promise<boolean> => {
    const entry = (await status({ dir })).find((e) => e.harness === harness);
    return (entry?.wiredEvents.length ?? 0) > 0;
  };
  if (!(await wiredIn(base)) || !(await wiredIn(project))) return undefined;

  return [
    `  AER is also wired for ${harness} in ${configPathFor(harness, project)}.`,
    '  Both layers load, so every event would be recorded twice and the run',
    '  split across records. Uninstall one of them.',
  ].join('\n');
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

/**
 * Why CODEX_HOME cannot be used, or undefined. Codex resolves a relative
 * value against its own working directory, which differs from run to run and
 * from the installer's, so there is no one file to install into. Empty is
 * unset.
 */
export function relativeCodexHome(): string | undefined {
  const v = process.env['CODEX_HOME'];
  return v !== undefined && v.length > 0 && !path.isAbsolute(v) ? v : undefined;
}

/**
 * The config file this command reads and writes. Codex keeps its user-level
 * config in $CODEX_HOME when that is set, not ~/.codex, so for the user's own
 * home that is where its hooks.json is. A relative CODEX_HOME is refused by
 * install and flagged by the doctor (see relativeCodexHome); here it falls
 * back to ~/.codex so that status and uninstall still read something.
 */
function configFile(harness: Harness, opts: InstallOptions): string {
  const base = baseDir(opts);
  if (harness === 'codex' && path.resolve(base) === path.resolve(os.homedir())) {
    const codexHome = process.env['CODEX_HOME'];
    if (codexHome !== undefined && path.isAbsolute(codexHome)) return path.join(codexHome, 'hooks.json');
  }
  return configPathFor(harness, base);
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
  const rel = harness === 'codex' ? relativeCodexHome() : undefined;
  if (rel !== undefined && path.resolve(baseDir(opts)) === path.resolve(os.homedir())) {
    throw new Error(
      `refusing to install: CODEX_HOME is set to a relative path (${rel}), which Codex resolves against whatever directory it starts in, ` +
        'so no one hooks.json would be read. Set CODEX_HOME to an absolute path, or unset it, and run the install again.',
    );
  }
  const file = configFile(harness, opts);
  const config = await readJsonOrAbort(file);
  if (opts.envFile !== undefined && !isSafeToPin(opts.envFile)) throw new Error('refusing an --env-file path with control characters');
  const envFile = opts.envFile ?? existingEnvFile(config);
  if (harness === 'antigravity') return installAntigravity(file, config, envFile);

  const existingHooks =
    typeof config['hooks'] === 'object' && config['hooks'] !== null && !Array.isArray(config['hooks'])
      ? ({ ...(config['hooks'] as Record<string, unknown>) } as HooksMap)
      : ({} as HooksMap);

  const events = harness === 'claude-code' ? CLAUDE_EVENTS : CODEX_EVENTS;
  const added: string[] = [];
  const alreadyPresent: string[] = [];
  const upgraded: string[] = [];

  for (const ev of events) {
    // SessionStart now also opens the upstream session (writing the pending
    // marker + pid alias before the POST), so it needs the same headroom
    // SessionEnd already had, rather than the harness's default hook budget.
    const timeout = harness === 'claude-code' && (ev === 'SessionEnd' || ev === 'SessionStart')
      ? CLAUDE_HEADROOM_TIMEOUT_S
      : undefined;
    const command = harnessCommand(harness, undefined, envFile, endBudgetMs(harness, ev));
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
  envFile: string | undefined,
): Promise<InstallResult> {
  const want = antigravityGroup(envFile);
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
  const file = configFile(harness, opts);
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
  /** The exact AER commands found wired in, deduplicated. Feeds `aer doctor`'s staleness checks. */
  commands: string[];
  /** The AER commands on the entry that ends a session (SessionEnd, or Antigravity's Stop). */
  endCommands?: string[];
}

/** The event whose entry ends a session in each harness. */
export function endEventOf(harness: Harness): string {
  return harness === 'antigravity' ? 'Stop' : 'SessionEnd';
}

/**
 * The ~/.codex/hooks.json that still carries AER entries while CODEX_HOME
 * points Codex elsewhere, or undefined. Codex does not read it now, so the
 * entries are invisible to status and uninstall; and should CODEX_HOME be
 * unset they fire again, alongside the registration under CODEX_HOME.
 */
/** Whether two directories are the same one, following links; either may not exist yet. */
async function sameDirectory(a: string, b: string): Promise<boolean> {
  const real = async (p: string): Promise<string> => {
    try { return await fs.realpath(p); } catch { return path.resolve(p); }
  };
  return (await real(a)) === (await real(b));
}

export async function strandedCodexRegistration(): Promise<string | undefined> {
  const active = configFile('codex', {});
  const legacy = configPathFor('codex', os.homedir());
  // The same file under two names is not a stray: a dotfile manager often
  // links ~/.codex to CODEX_HOME or the other way round, and calling it a
  // stray would point the user at an uninstall of the live registration.
  if (await sameDirectory(path.dirname(active), path.dirname(legacy))) return undefined;
  try {
    const hooks = (await readJsonOrAbort(legacy))['hooks'];
    if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return undefined;
    const wired = Object.values(hooks as HooksMap).some((groups) => Array.isArray(groups) && groups.some(groupHasAer));
    return wired ? legacy : undefined;
  } catch {
    return undefined;
  }
}

/** Report which events currently carry an AER hook entry, per harness. */
export async function status(opts: InstallOptions = {}): Promise<StatusEntry[]> {
  const out: StatusEntry[] = [];
  for (const harness of ['claude-code', 'codex', 'antigravity'] as const) {
    const file = configFile(harness, opts);
    let exists = false;
    let wiredEvents: string[] = [];
    let resolves = true;
    try {
      await fs.access(file);
      exists = true;
    } catch {
      out.push({ harness, path: file, exists: false, wiredEvents, resolves: true, commands: [] });
      continue;
    }
    let commands: string[] = [];
    const endCommands: string[] = [];
    try {
      const config = await readJsonOrAbort(file);
      // Antigravity's groups sit at the root under our own key, with no wrapper.
      const hooks = harness === 'antigravity' ? config[AER_GROUP_NAME] : config['hooks'];
      if (typeof hooks === 'object' && hooks !== null && !Array.isArray(hooks)) {
        for (const [ev, groups] of Object.entries(hooks as HooksMap)) {
          if (!Array.isArray(groups) || !groups.some(groupHasAer)) continue;
          wiredEvents.push(ev);
          for (const g of groups) {
            // Antigravity puts the command on the entry itself, the others nest it.
            const entries = [...(g.hooks ?? []), ...(harness === 'antigravity' ? [g] : [])];
            for (const h of entries) {
              if (!isAerEntry(h)) continue;
              const command = (h as HookCommandEntry).command.trim();
              commands.push(command);
              if (ev === endEventOf(harness)) endCommands.push(command);
            }
          }
        }
        commands = [...new Set(commands)];
        resolves = commands.length === 0 || commands.every(hookCommandResolves);
      }
    } catch {
      // Malformed config: the file exists but yields no readable AER wiring.
      wiredEvents = [];
    }
    out.push({ harness, path: file, exists, wiredEvents, resolves, commands, endCommands });
  }
  return out;
}
