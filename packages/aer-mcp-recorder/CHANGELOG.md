# Changelog

## 0.1.0 - 2026-07-20

First public release. A transparent MCP proxy that records the tool activity a
coding harness drives through the Model Context Protocol, with no harness
integration.

### Added

- A stdio MCP proxy (`aer-mcp-recorder`) that sits between a harness and an MCP
  server, forwarding JSON-RPC byte-for-byte while recording tool calls into AER.
- Programmatic entry points for embedding the recorder.

### Privacy boundary

Records tool and method names only by default. Tool arguments and results are never
recorded unless explicitly enabled.

### Reliability

Fail-open byte transparency: the proxy never alters or blocks the JSON-RPC stream,
and a recording fault is swallowed so it cannot break the harness or the MCP server.
