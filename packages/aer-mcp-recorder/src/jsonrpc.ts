// Minimal JSON-RPC 2.0 types and tolerant framing helpers for the MCP recorder.
//
// MCP stdio transport frames messages as newline-delimited JSON. We never want a
// malformed or non-JSON line to throw in the recording path, so `parseJsonRpc`
// returns null on anything it cannot parse and `LineSplitter` reassembles partial
// UTF-8 chunks without ever raising.

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse;

/**
 * Tolerant parse: returns a plain object for any valid JSON object, otherwise null.
 * Never throws. Non-object JSON (arrays, numbers, strings, null) also yields null
 * because JSON-RPC messages are always objects (batches are unwrapped by the caller
 * if ever needed; MCP does not use them over stdio in practice).
 */
export function parseJsonRpc(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Stateful newline framer. Feed it Buffer (or string) chunks; it returns the
 * complete lines contained in what it has seen so far, buffering any trailing
 * partial line for the next call. Handles \n and \r\n. Never throws.
 */
export class LineSplitter {
  private buffer = '';

  /** Push a chunk, get back zero or more complete lines (without their newline). */
  push(chunk: Buffer | string): string[] {
    try {
      this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    } catch {
      return [];
    }
    const lines: string[] = [];
    let idx = this.buffer.indexOf('\n');
    while (idx !== -1) {
      let line = this.buffer.slice(0, idx);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      lines.push(line);
      this.buffer = this.buffer.slice(idx + 1);
      idx = this.buffer.indexOf('\n');
    }
    return lines;
  }

  /** Any buffered partial line not yet terminated by a newline. */
  flush(): string | null {
    if (this.buffer.length === 0) return null;
    const rest = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer;
    this.buffer = '';
    return rest.length > 0 ? rest : null;
  }
}
