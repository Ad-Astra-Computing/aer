// @adastracomputing/aer-mcp-recorder - transparent MCP proxy that records the tool
// activity a coding harness drives through MCP, with no harness integration.
//
// Two non-negotiable properties: fail-open byte transparency (the proxy forwards
// every byte unchanged; recording is best-effort and never in the critical path)
// and redaction by default (tool names, argument key names, error flags, result
// sizes and timing only, never argument values or result content unless opted in).
//
// The stdio proxy entry point lives at the "./stdio" subpath and the CLI at the
// `aer-mcp-recorder` bin.

export { McpRecorder, COLLECTOR_NAME, COLLECTOR_VERSION } from './recorder.js';
export type { RecorderOptions, CoverageReport } from './recorder.js';

export { createHttpSink, sinkFromEnv, NullSink } from './sink.js';
export type { EventSink, HttpSinkOptions, Principal } from './sink.js';

export { parseJsonRpc, LineSplitter } from './jsonrpc.js';
export type { JsonRpcId, JsonRpcRequest, JsonRpcResponse, JsonRpcMessage } from './jsonrpc.js';
