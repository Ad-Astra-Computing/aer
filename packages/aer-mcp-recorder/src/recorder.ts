// Transport-agnostic MCP recording core.
//
// The proxy parses each newline-delimited JSON-RPC message flowing in either
// direction and feeds it to `observeClientMessage` / `observeServerMessage`.
// The recorder correlates `tools/call` requests with their responses and emits
// AER events. Both observe methods are wrapped so they NEVER throw to the caller:
// a bug here must not affect byte forwarding.
//
// REDACTION BY DEFAULT: only tool names, argument KEY names, result is_error and
// result size, and timing are captured. Argument values and result content are
// captured only when explicitly opted in (recordArgumentValues / recordResultContent).

import type { EventSink } from './sink.js';

export const COLLECTOR_NAME = '@adastracomputing/aer-mcp-recorder';
export const COLLECTOR_VERSION = '0.1.0';

const MAX_PENDING = 4096;

export interface RecorderOptions {
  sink: EventSink;
  /** Capture full argument objects (values), not just key names. Default false. */
  recordArgumentValues?: boolean;
  /** Capture full result content. Default false. */
  recordResultContent?: boolean;
  /** Clock injection (ms since epoch). Default Date.now. */
  now?: () => number;
}

export interface CoverageReport {
  recorder: { name: string; version: string };
  server?: { name: string; version: string };
  tools_seen: string[];
  calls: number;
  errors: number;
}

interface PendingCall {
  tool: string;
  startedAt: number;
  kind?: string;
}

type IdKey = string;

function idKey(id: unknown): IdKey | null {
  if (typeof id === 'string') return 's:' + id;
  if (typeof id === 'number') return 'n:' + String(id);
  return null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Classify a tool name into a richer AER event kind ONLY when the name alone is
 * unambiguous. Conservative on purpose: when unsure, return undefined and the
 * generic tool.* events stand on their own.
 */
function classifyTool(name: string): string | undefined {
  const n = name.toLowerCase();
  if (/(^|[_./-])(write|create|edit|patch|append)([_./-]?file|_?fs)?/.test(n) && n.includes('file')) {
    return 'file.write';
  }
  if (/(^|[_./-])(read|get|cat|open)([_./-]?file)?/.test(n) && n.includes('file')) {
    return 'file.read';
  }
  if (n.includes('write_file') || n === 'writefile' || n === 'fs_write') return 'file.write';
  if (n.includes('read_file') || n === 'readfile' || n === 'fs_read') return 'file.read';
  if (/(^|[_./-])(exec|shell|bash|run_command|process|spawn)/.test(n)) return 'process.exec';
  return undefined;
}

export class McpRecorder {
  private readonly sink: EventSink;
  private readonly recordArgs: boolean;
  private readonly recordResults: boolean;
  private readonly now: () => number;

  private readonly pending = new Map<IdKey, PendingCall>();
  private readonly toolsSeen = new Set<string>();
  private server: { name: string; version: string } | undefined;
  private calls = 0;
  private errors = 0;
  private closed = false;

  constructor(opts: RecorderOptions) {
    this.sink = opts.sink;
    this.recordArgs = opts.recordArgumentValues ?? false;
    this.recordResults = opts.recordResultContent ?? false;
    this.now = opts.now ?? Date.now;
  }

  /** Feed a parsed JSON-RPC message sent by the harness (client). Never throws. */
  observeClientMessage(msg: unknown): void {
    try {
      this.handleClient(msg);
    } catch {
      /* best-effort: drop */
    }
  }

  /** Feed a parsed JSON-RPC message sent by the MCP server. Never throws. */
  observeServerMessage(msg: unknown): void {
    try {
      this.handleServer(msg);
    } catch {
      /* best-effort: drop */
    }
  }

  private safeEmit(eventType: string, payload: Record<string, unknown>): void {
    try {
      const r = this.sink.emit(eventType, payload);
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch(() => undefined);
      }
    } catch {
      /* best-effort */
    }
  }

  private handleClient(msg: unknown): void {
    if (!isObject(msg)) return;
    const method = typeof msg['method'] === 'string' ? (msg['method'] as string) : undefined;
    if (!method) return;
    const params = isObject(msg['params']) ? (msg['params'] as Record<string, unknown>) : undefined;

    if (method === 'tools/call') {
      const name = params && typeof params['name'] === 'string' ? (params['name'] as string) : undefined;
      if (!name) return;
      this.toolsSeen.add(name);
      this.calls++;
      const args = params && isObject(params['arguments']) ? (params['arguments'] as Record<string, unknown>) : undefined;
      const kind = classifyTool(name);
      const key = idKey(msg['id']);
      if (key) {
        if (this.pending.size >= MAX_PENDING) {
          const oldest = this.pending.keys().next().value;
          if (oldest !== undefined) this.pending.delete(oldest);
        }
        const entry: PendingCall = { tool: name, startedAt: this.now() };
        if (kind !== undefined) entry.kind = kind;
        this.pending.set(key, entry);
      }
      const payload: Record<string, unknown> = { tool: name };
      if (kind !== undefined) payload['kind'] = kind;
      if (args) payload['arg_keys'] = Object.keys(args);
      if (this.recordArgs && args) payload['arguments'] = args;
      this.safeEmit('tool.started', payload);
      return;
    }

    if (method === 'initialize' && params) {
      const info = isObject(params['clientInfo']) ? (params['clientInfo'] as Record<string, unknown>) : undefined;
      const payload: Record<string, unknown> = {};
      if (typeof params['protocolVersion'] === 'string') payload['protocol_version'] = params['protocolVersion'];
      if (info && typeof info['name'] === 'string') payload['client_name'] = info['name'];
      if (info && typeof info['version'] === 'string') payload['client_version'] = info['version'];
      this.safeEmit('mcp.initialize', payload);
      return;
    }

    if (method === 'tools/list') {
      this.safeEmit('mcp.tools.list.requested', {});
      return;
    }
  }

  private handleServer(msg: unknown): void {
    if (!isObject(msg)) return;

    // Responses carry an id and either result or error.
    if ('id' in msg && ('result' in msg || 'error' in msg)) {
      const key = idKey(msg['id']);
      const hasError = 'error' in msg && msg['error'] != null;
      const result = isObject(msg['result']) ? (msg['result'] as Record<string, unknown>) : undefined;

      // tools/list result: capture discovered tool names.
      if (!hasError && result && Array.isArray(result['tools'])) {
        const names: string[] = [];
        for (const t of result['tools'] as unknown[]) {
          if (isObject(t) && typeof t['name'] === 'string') {
            names.push(t['name'] as string);
            this.toolsSeen.add(t['name'] as string);
          }
        }
        this.safeEmit('mcp.tools.list', { count: names.length, tools: names });
        // do not return; a tools/list response is not a pending tool call
      }

      // initialize result: capture serverInfo.
      if (!hasError && result && isObject(result['serverInfo'])) {
        const info = result['serverInfo'] as Record<string, unknown>;
        const name = typeof info['name'] === 'string' ? (info['name'] as string) : undefined;
        const version = typeof info['version'] === 'string' ? (info['version'] as string) : undefined;
        if (name) this.server = { name, version: version ?? 'unknown' };
      }

      if (key && this.pending.has(key)) {
        const call = this.pending.get(key);
        this.pending.delete(key);
        if (!call) return;
        const durationMs = Math.max(0, this.now() - call.startedAt);
        const resultIsError = result && result['isError'] === true;
        const isError = Boolean(hasError || resultIsError);
        if (isError) this.errors++;

        const payload: Record<string, unknown> = {
          tool: call.tool,
          ok: !isError,
          is_error: isError,
          duration_ms: durationMs,
        };
        if (call.kind !== undefined) payload['kind'] = call.kind;
        if (result !== undefined) {
          payload['result_size'] = resultSize(result);
          if (this.recordResults) payload['result'] = result;
        } else if (hasError && isObject(msg['error'])) {
          const err = msg['error'] as Record<string, unknown>;
          if (typeof err['code'] === 'number') payload['error_code'] = err['code'];
        }
        this.safeEmit('tool.completed', payload);
      }
    }
  }

  /** Coverage summary of what the recorder observed. */
  report(): CoverageReport {
    const report: CoverageReport = {
      recorder: { name: COLLECTOR_NAME, version: COLLECTOR_VERSION },
      tools_seen: [...this.toolsSeen].sort(),
      calls: this.calls,
      errors: this.errors,
    };
    if (this.server !== undefined) report.server = this.server;
    return report;
  }

  /**
   * Emit the coverage report as a final event, then flush and complete the sink.
   * Idempotent. Best-effort: never rejects.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.safeEmit('mcp.recorder.report', this.report() as unknown as Record<string, unknown>);
    } catch {
      /* best-effort */
    }
    try {
      await this.sink.close();
    } catch {
      /* best-effort */
    }
  }
}

function resultSize(result: Record<string, unknown>): number {
  try {
    return Buffer.byteLength(JSON.stringify(result), 'utf8');
  } catch {
    return 0;
  }
}
