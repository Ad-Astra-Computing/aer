// Reduce a tool call to the thing it actually did, the way the transcript
// importer already does, so both paths describe a run the same way.

// The reduction is the privacy boundary: a command line becomes program
// names and hosts, a URL becomes one host, and anything that does not reduce
// cleanly is dropped rather than approximated.

import { UNKNOWN_COMMAND } from './shared/shell-reduce.js';
import { reduceShellLine } from './shell-line.js';

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
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'write_file', 'edit_file', 'replace_file_content']);
const FETCH_TOOLS = new Set(['WebFetch', 'web_fetch', 'read_url_content']);

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
 * provider it queries is not known here, so none is invented.
 */
export function shapesOfToolCall(tool: string, input: unknown): ToolShape[] {
  if (tool.length === 0) return [];
  const args = asRecord(input) ?? {};

  if (SHELL_TOOLS.has(tool)) {
    if (asString(args['command']) === undefined) return [];
    const line = reduceShellLine(args['command']);
    const shapes = line.programs.map(exec);
    if (line.unknown) shapes.push(exec(UNKNOWN_COMMAND));
    for (const host of line.hosts) {
      const h = bounded(host);
      if (h !== undefined) shapes.push({ eventType: 'network.connect', payload: { host: h } });
    }
    return shapes;
  }

  if (FETCH_TOOLS.has(tool)) {
    const target = urlOf(args['url']);
    return target === undefined ? [] : [{ eventType: 'network.connect', payload: target }];
  }

  const path = bounded(args['file_path'] ?? args['notebook_path'] ?? args['path'] ?? args['absolute_path']);
  if (path !== undefined && READ_TOOLS.has(tool)) return [{ eventType: 'file.opened', payload: { path } }];
  if (path !== undefined && WRITE_TOOLS.has(tool)) return [{ eventType: 'file.written', payload: { path } }];

  const server = mcpServer(tool);
  if (server !== undefined) return [{ eventType: 'tool.selected', payload: { tool, server } }];

  return [];
}
