// Reduce a tool call to the thing it actually did, the way the transcript
// importer already does, so both paths describe a run the same way.

// The reduction is the privacy boundary: a command line becomes one program
// name, a URL becomes one host, and anything that does not reduce cleanly is
// dropped rather than approximated.

import { reduceShellCommand, UNKNOWN_COMMAND } from './shared/shell-reduce.js';

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

function hostOf(url: unknown): string | undefined {
  const s = asString(url);
  if (s === undefined) return undefined;
  try {
    return bounded(new URL(s).hostname);
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
 * one we recognise. Callers still record the tool name either way, so an
 * unrecognised tool loses detail and never loses the call.
 */
export function shapeOfToolCall(tool: string, input: unknown): ToolShape | undefined {
  if (tool.length === 0) return undefined;
  const args = asRecord(input) ?? {};

  if (SHELL_TOOLS.has(tool)) {
    if (asString(args['command']) === undefined) return undefined;
    const command = reduceShellCommand(args['command']);
    // A refusal is recorded as a refusal, so it stays countable and is never
    // mistaken for a program called `unknown`.
    return {
      eventType: 'process.exec',
      payload: command === UNKNOWN_COMMAND
        ? { command: UNKNOWN_COMMAND, command_known: false }
        : { command, command_known: true },
    };
  }

  if (FETCH_TOOLS.has(tool)) {
    const host = hostOf(args['url']);
    return host === undefined ? undefined : { eventType: 'http.requested', payload: { host, method: 'GET' } };
  }

  const path = bounded(args['file_path'] ?? args['notebook_path'] ?? args['path'] ?? args['absolute_path']);
  if (path !== undefined && READ_TOOLS.has(tool)) return { eventType: 'file.opened', payload: { path } };
  if (path !== undefined && WRITE_TOOLS.has(tool)) return { eventType: 'file.written', payload: { path } };

  const server = mcpServer(tool);
  if (server !== undefined) return { eventType: 'tool.selected', payload: { tool, server } };

  return undefined;
}
