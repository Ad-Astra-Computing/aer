# Changelog

## 0.1.1

### Patch Changes

- [`76fa987`](https://github.com/Ad-Astra-Computing/aer/commit/76fa987981cd578bba88f306ac51a120dde7d98b) Thanks [@jasonodoom](https://github.com/jasonodoom)! - README now states the package is ESM only and lists its Node floor. Also
  reworded the `--help` usage text to drop an em dash, with no change in
  behavior.

- [`76fa987`](https://github.com/Ad-Astra-Computing/aer/commit/76fa987981cd578bba88f306ac51a120dde7d98b) Thanks [@jasonodoom](https://github.com/jasonodoom)! - Raise the default shutdown flush budget from 3s to 15s (covers the three
  sequential prod round trips at close: open, events, complete), make it
  configurable with `AER_CLOSE_TIMEOUT_MS`, and exit 70 with a stderr diagnostic
  when it is exceeded instead of a silent 0. A signal-killed child now reports
  `128 + signal number` instead of a false success. `AER_AGENT_VERSION` defaults
  to `mcp-recorder/<package version>` when unset, since the API requires an
  agent version on every session.
- Updated dependencies [[`5e9231a`](https://github.com/Ad-Astra-Computing/aer/commit/5e9231ada1e4e704e3fb5720eb966acac8f5afec), [`5e9231a`](https://github.com/Ad-Astra-Computing/aer/commit/5e9231ada1e4e704e3fb5720eb966acac8f5afec)]:
  - @adastracomputing/aer-emit@0.1.1

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
