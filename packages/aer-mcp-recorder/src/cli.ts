#!/usr/bin/env node
// aer-mcp-recorder CLI: wrap a real MCP server command so AER records its tool
// activity through a transparent proxy.
//
//   aer-mcp-recorder [--] <command> [args...]
//
// Everything after `--` (or after the first non-flag argument) is the real MCP
// server command line. Recording is configured from the AER_* environment
// variables; when unconfigured the proxy forwards bytes and records nothing.

import { createStdioProxy } from './stdio.js';
import { McpRecorder } from './recorder.js';
import { sinkFromEnv, NullSink } from './sink.js';
import { isInvokedDirectly } from './invoked-directly.js';

/**
 * Parse AER_CLOSE_TIMEOUT_MS: a positive integer, in ms, or unset. An unset or
 * invalid value falls back to stdio.ts's DEFAULT_CLOSE_TIMEOUT_MS; an invalid
 * one is reported once so a typo does not silently pick the default.
 */
export function parseCloseTimeoutMs(env: NodeJS.ProcessEnv, warn: (message: string) => void): number | undefined {
  const raw = env['AER_CLOSE_TIMEOUT_MS'];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    warn(`aer-mcp-recorder: ignoring invalid AER_CLOSE_TIMEOUT_MS=${JSON.stringify(raw)}; using the default`);
    return undefined;
  }
  return n;
}

const USAGE = `aer-mcp-recorder: transparent MCP proxy that records tool activity for AER

Usage:
  aer-mcp-recorder [--] <command> [args...]

Wraps <command> as an MCP server. The harness talks to this proxy instead of the
real server; every byte is forwarded unchanged and a copy is parsed for recording.

Recording is best-effort and never in the critical path. If AER is unconfigured or
unreachable, tools keep working exactly as if the proxy were not there.

Redaction by default: only tool names, argument key names, error flags, result
sizes and timing are captured. Set AER_MCP_RECORD_ARGS=1 to also capture argument
values and AER_MCP_RECORD_RESULTS=1 to capture result content.

Configuration (environment):
  AER_API_KEY, AER_TENANT_ID, AER_AGENT_ID   required to record (else no-op)
  AER_ENV_ID                                 optional session metadata
  AER_AGENT_VERSION                          defaults to mcp-recorder/<version>
  AER_BASE_URL                               default https://api.aer.run
  AER_PRINCIPAL_ID/_KIND/_DISPLAY            optional human/service/ci attribution
  AER_MCP_RECORD_ARGS=1                       capture argument values (off by default)
  AER_MCP_RECORD_RESULTS=1                    capture result content (off by default)
  AER_CLOSE_TIMEOUT_MS                        shutdown flush budget in ms (default 15000)
`;

function parseArgs(argv: string[]): { command: string; args: string[] } | { help: true } | null {
  const rest = argv.slice(2);
  if (rest.length === 0) return null;
  if (rest[0] === '-h' || rest[0] === '--help') return { help: true };

  let commandIndex = -1;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--') {
      commandIndex = i + 1;
      break;
    }
    if (!rest[i]!.startsWith('-')) {
      commandIndex = i;
      break;
    }
  }
  if (commandIndex === -1 || commandIndex >= rest.length) return null;
  const command = rest[commandIndex]!;
  return { command, args: rest.slice(commandIndex + 1) };
}

function buildRecorder(): McpRecorder {
  let sink;
  try {
    sink = sinkFromEnv() ?? new NullSink();
  } catch {
    sink = new NullSink();
  }
  const recordArgs = process.env['AER_MCP_RECORD_ARGS'] === '1';
  const recordResults = process.env['AER_MCP_RECORD_RESULTS'] === '1';
  return new McpRecorder({ sink, recordArgumentValues: recordArgs, recordResultContent: recordResults });
}

export async function main(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed === null) {
    process.stderr.write(USAGE + '\n');
    return 2;
  }
  if ('help' in parsed) {
    process.stdout.write(USAGE);
    return 0;
  }

  let recorder: McpRecorder | null = null;
  try {
    recorder = buildRecorder();
  } catch {
    recorder = null; // a recorder failure must never crash the child
  }

  const closeTimeoutMs = parseCloseTimeoutMs(env, (message) => {
    try {
      process.stderr.write(message + '\n');
    } catch {
      /* stderr may already be gone; never throw from a diagnostic */
    }
  });

  const proxy = createStdioProxy({
    command: parsed.command,
    args: parsed.args,
    recorder,
    ...(closeTimeoutMs !== undefined ? { closeTimeoutMs } : {}),
  });
  return proxy.done;
}

// Only run when invoked directly (not when imported by a test). Must resolve
// symlinks: npm invokes the bin through a node_modules/.bin symlink.
if (isInvokedDirectly(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
