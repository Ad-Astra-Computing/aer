// Reduce a tool call to the thing it actually did, the way the transcript
// importer already does, so both paths describe a run the same way.

// The reduction is the privacy boundary: a command line becomes program
// names and hosts, a URL becomes one host, and anything that does not reduce
// cleanly is dropped rather than approximated.

import { UNKNOWN_COMMAND } from './shared/shell-reduce.js';
import { reduceShellLine, type ProgramLabel } from './shell-line.js';
import { classifyPath } from './shared/path-class-mirror.js';
import { isAbsolute, join } from 'node:path';

/** Local copies: importing them from the normalizer would be a cycle. */
function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}


export interface ToolShape {
  eventType: string;
  payload: Record<string, unknown>;
}

/**
 * What ingest accepts for a name-shaped value (MAX_FIELD_LEN in the API's
 * schema). Anything longer is rejected per event, so sending it loses the
 * detail and tells nobody.
 */
const MAX_FIELD = 512;

function bounded(v: unknown): string | undefined {
  const s = asString(v);
  return s !== undefined && s.length <= MAX_FIELD ? s : undefined;
}

// The same call has a different tool name in each harness.
const SHELL_TOOLS = new Set(['Bash', 'BashOutput', 'shell', 'run_command', 'run_terminal_command']);
const READ_TOOLS = new Set(['Read', 'NotebookRead', 'read_file', 'view_file']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'write_file', 'edit_file', 'write_to_file', 'replace_file_content']);
const FETCH_TOOLS = new Set(['WebFetch', 'web_fetch', 'read_url_content']);
// Grep/Glob previously emitted no typed event (visibility research gap).
// Claude Code's own names; other harnesses that expose an equivalent search
// tool are not yet known, so only these are listed (a known simplification).
const GREP_TOOLS = new Set(['Grep']);
const GLOB_TOOLS = new Set(['Glob']);
/** Credential-shaped substrings a search pattern is checked against (T2).
 *  The pattern text itself is never sent, only which class (if any) one of
 *  these matched. */
const SEARCH_CLASS_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/id_rsa/i, 'ssh_key'],
  [/\.env\b/i, 'env_file'],
  [/token/i, 'token_cache'],
  [/secret/i, 'secrets_dir'],
  [/wallet/i, 'wallet'],
];
// Claude Code's Skill tool. Its tool_input carries the invoked skill's name
// under `skill`; any other argument it sends is the skill's own arguments,
// which must never reach the wire (bodies-off).
const SKILL_TOOL = 'Skill';
// Same bound the server enforces on skill.invoked's `skill` field (see
// isSafeName in the API repo's packages/schemas/src/event.ts): a free-form
// display name, bounded only on length and control characters, never the
// identifier()-style pattern a closed-set label would need.
const SKILL_NAME_MAX_LEN = 256;
// eslint-disable-next-line no-control-regex
const SKILL_NAME_FORBIDDEN_CONTROL = /[\u0000-\u001f\u007f]/;

function skillName(v: unknown): string | undefined {
  const s = asString(v);
  if (s === undefined || s.length > SKILL_NAME_MAX_LEN || SKILL_NAME_FORBIDDEN_CONTROL.test(s)) return undefined;
  return s;
}

// Codex writes every file through this one tool, whose only argument is the
// patch text.
const PATCH_TOOL = 'apply_patch';
// The most files one patch contributes, as with the programs of a shell line.
const MAX_PATCH_FILES = 16;
// The headers a patch names a file with. Nothing after the header line is read.
const PATCH_FILE_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/;

// The same argument has a different name in each harness: Claude Code and
// Codex use snake_case, Antigravity sends PascalCase (CommandLine,
// AbsolutePath, TargetFile, Url), captured from agy 1.2.6.
function firstOf(args: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) if (args[k] !== undefined && args[k] !== null) return args[k];
  return undefined;
}
const COMMAND_KEYS = ['command', 'CommandLine'] as const;
const PATH_KEYS = ['file_path', 'notebook_path', 'path', 'absolute_path', 'AbsolutePath', 'TargetFile'] as const;
const URL_KEYS = ['url', 'Url'] as const;
const PATTERN_KEYS = ['pattern'] as const;

/**
 * Every distinct file a patch adds, updates, deletes or moves to, in order,
 * never its content. Headers are read only inside the patch envelope, and a
 * header that names no file is skipped.
 */
function patchPaths(patch: unknown, cwd: string | undefined): string[] {
  const text = asString(patch);
  if (text === undefined) return [];
  const seen = new Set<string>();
  // Only inside the envelope: the hook sees the call before Codex validates
  // it, and a header-shaped line outside it names no file Codex will touch.
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    if (line === '*** Begin Patch') { inside = true; continue; }
    if (line === '*** End Patch') { inside = false; continue; }
    if (!inside) continue;
    const m = PATCH_FILE_HEADER.exec(line);
    if (m === null) continue;
    const named = m[1]!.trim();
    // A header with nothing after it names no file; joined to cwd it would
    // record the working directory itself as written.
    if (named.length === 0) continue;
    const path = bounded(cwd !== undefined && !isAbsolute(named) ? join(cwd, named) : named);
    if (path === undefined) continue;
    seen.add(path);
  }
  return [...seen];
}

/** The file.written events a patch reduces to, at most MAX_PATCH_FILES of them. */
function patchedFiles(patch: unknown, cwd: string | undefined): ToolShape[] {
  return patchPaths(patch, cwd).slice(0, MAX_PATCH_FILES).map((path) => ({ eventType: 'file.written', payload: { path } }));
}

/** How many distinct files a Codex patch names, recorded or not. */
export function patchFileCount(input: unknown): number {
  return patchPaths(asRecord(input)?.['command'], undefined).length;
}

/** The most files one patch contributes to a record. */
export const PATCH_FILE_CAP = MAX_PATCH_FILES;

/** The host and scheme of a fetched URL, never its user, path or query. */
function urlOf(url: unknown): { host: string; scheme: string } | undefined {
  const s = asString(url);
  if (s === undefined) return undefined;
  try {
    const u = new URL(s);
    const host = bounded(u.hostname);
    const scheme = u.protocol.replace(/:$/, '');
    return host === undefined || !/^[a-z][a-z0-9+.-]{0,15}$/.test(scheme) ? undefined : { host, scheme };
  } catch {
    return undefined;
  }
}

/** The MCP server a namespaced tool belongs to, per the mcp__server__tool form. */
export function mcpServer(tool: string): string | undefined {
  const parts = tool.split('__');
  return parts.length >= 3 && parts[0] === 'mcp' ? bounded(parts[1]) : undefined;
}

/**
 * The typed event a tool call reduces to, or nothing when the shape is not
 * one we recognise. For a shell line this is its first program; see
 * `shapesOfToolCall` for all of them.
 */
export function shapeOfToolCall(tool: string, input: unknown): ToolShape | undefined {
  return shapesOfToolCall(tool, input)[0];
}

/**
 * The raw (unclassified) remote/branch names of a plain, single-branch
 * `git push` on a shell tool call, for vcs.pushed's before/after ref lookup.
 * Local-only: see ShellLineReduction.gitPushTarget's comment. Never put on
 * the wire: the caller uses this only to pick a `git rev-parse` argument
 * for its own local subprocess call.
 */
export function vcsPushTargetOfToolCall(tool: string, input: unknown): { remote: string; branch: string } | undefined {
  if (!SHELL_TOOLS.has(tool)) return undefined;
  const args = asRecord(input) ?? {};
  const command = firstOf(args, COMMAND_KEYS);
  if (asString(command) === undefined) return undefined;
  return reduceShellLine(command).gitPushTarget;
}

/** A ProgramLabel's fields as sent on the wire, one more key than the
 *  closed-set payload keys below allow through: `ai_cli` carries an object,
 *  the sanitizer validates its shape server-side (sanitizeAiCli). */
function labelPayload(label: ProgramLabel | undefined): Record<string, unknown> {
  return label === undefined ? {} : { ...label };
}

function exec(command: string, label?: ProgramLabel): ToolShape {
  // A refusal is recorded as a refusal, so it stays countable and is never
  // mistaken for a program called `unknown`.
  return {
    eventType: 'process.exec',
    payload: command === UNKNOWN_COMMAND
      ? { command: UNKNOWN_COMMAND, command_known: false }
      : { command, command_known: true, ...labelPayload(label) },
  };
}

/**
 * Every typed event a tool call reduces to, in order. Callers still record
 * the tool name either way, so an unrecognised tool loses detail and never
 * loses the call.
 *
 * A shell line yields one process.exec per distinct program and one
 * network.connect per host a network client was pointed at. A fetch yields
 * network.connect for its host: the hook sees the tool asked for, never the
 * request itself, so no method is claimed. A web search yields nothing: the
 * provider it queries is not known here, so none is invented. A Codex patch
 * yields file.written for each file its headers name, resolved against `cwd`
 * when one is given and the header is relative.
 */
export function shapesOfToolCall(tool: string, input: unknown, opts: { cwd?: string | undefined } = {}): ToolShape[] {
  if (tool.length === 0) return [];
  const args = asRecord(input) ?? {};

  if (SHELL_TOOLS.has(tool)) {
    const command = firstOf(args, COMMAND_KEYS);
    if (asString(command) === undefined) return [];
    const line = reduceShellLine(command);
    const shapes = line.programs.map((p) => exec(p, line.labels[p]));
    if (line.unknown) shapes.push(exec(UNKNOWN_COMMAND));
    for (const host of line.hosts) {
      const h = bounded(host);
      if (h !== undefined) shapes.push({ eventType: 'network.connect', payload: { host: h, source: 'shell' } });
    }
    return shapes;
  }

  if (FETCH_TOOLS.has(tool)) {
    const target = urlOf(firstOf(args, URL_KEYS));
    return target === undefined ? [] : [{ eventType: 'network.connect', payload: target }];
  }

  if (tool === SKILL_TOOL) {
    const skill = skillName(args['skill']);
    return skill === undefined ? [] : [{ eventType: 'skill.invoked', payload: { skill } }];
  }

  if (tool === PATCH_TOOL) return patchedFiles(args['command'], opts.cwd !== undefined && isAbsolute(opts.cwd) ? opts.cwd : undefined);

  if (GREP_TOOLS.has(tool) || GLOB_TOOLS.has(tool)) {
    const payload: Record<string, unknown> = {};
    const searchPath = asString(firstOf(args, PATH_KEYS));
    if (searchPath !== undefined) {
      const cls = classifyPath(searchPath);
      if (cls !== null) payload['path_class'] = cls;
    }
    const pattern = asString(firstOf(args, PATTERN_KEYS));
    if (pattern !== undefined) {
      for (const [re, cls] of SEARCH_CLASS_PATTERNS) {
        if (re.test(pattern)) { payload['search_class'] = cls; break; }
      }
    }
    return [{ eventType: 'file.searched', payload }];
  }

  const path = bounded(firstOf(args, PATH_KEYS));
  if (path !== undefined && READ_TOOLS.has(tool)) return [{ eventType: 'file.opened', payload: { path } }];
  if (path !== undefined && WRITE_TOOLS.has(tool)) return [{ eventType: 'file.written', payload: { path } }];

  const server = mcpServer(tool);
  if (server !== undefined) return [{ eventType: 'tool.selected', payload: { tool, server } }];

  return [];
}
