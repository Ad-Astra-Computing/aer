// Reduce a tool call to the thing it actually did, the way the transcript
// importer already does, so both paths describe a run the same way.

// The reduction is the privacy boundary: a command line becomes program
// names and hosts, a URL becomes one host, and anything that does not reduce
// cleanly is dropped rather than approximated.

import { UNKNOWN_COMMAND } from './shared/shell-reduce.js';
import { reduceShellLine } from './shell-line.js';
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

/** The files a patch adds, updates, deletes or moves to, never its content. */
function patchedFiles(patch: unknown, cwd: string | undefined): ToolShape[] {
  const text = asString(patch);
  if (text === undefined) return [];
  const seen = new Set<string>();
  const out: ToolShape[] = [];
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
    const path = bounded(cwd !== undefined && !isAbsolute(named) ? join(cwd, named) : named);
    if (path === undefined || seen.has(path)) continue;
    seen.add(path);
    out.push({ eventType: 'file.written', payload: { path } });
    if (out.length >= MAX_PATCH_FILES) break;
  }
  return out;
}

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

function exec(command: string): ToolShape {
  // A refusal is recorded as a refusal, so it stays countable and is never
  // mistaken for a program called `unknown`.
  return {
    eventType: 'process.exec',
    payload: command === UNKNOWN_COMMAND ? { command: UNKNOWN_COMMAND, command_known: false } : { command, command_known: true },
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
    const shapes = line.programs.map(exec);
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

  if (tool === PATCH_TOOL) return patchedFiles(args['command'], opts.cwd !== undefined && isAbsolute(opts.cwd) ? opts.cwd : undefined);

  const path = bounded(firstOf(args, PATH_KEYS));
  if (path !== undefined && READ_TOOLS.has(tool)) return [{ eventType: 'file.opened', payload: { path } }];
  if (path !== undefined && WRITE_TOOLS.has(tool)) return [{ eventType: 'file.written', payload: { path } }];

  const server = mcpServer(tool);
  if (server !== undefined) return [{ eventType: 'tool.selected', payload: { tool, server } }];

  return [];
}
