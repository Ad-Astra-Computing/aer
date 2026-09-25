# Changelog

## 0.3.1

### Patch Changes

- Updated dependencies
  - @adastracomputing/aer-emit@0.4.0

## 0.3.0

### Minor Changes

- [`5d8c488`](https://github.com/Ad-Astra-Computing/aer/commit/5d8c4884b029fdc66566df9fbd36217e57de1a89) - **Breaking:** the minimum supported Node is now 22, up from 20.

  Node 20 reached end of life on 30 April 2026 and receives no further security
  fixes, so these packages no longer claim to support it. Node 22 is supported
  until 30 April 2027 and remains the floor until then. Node 24 is the current
  long-term support release and is recommended.

  With pnpm, which enforces this field, installing on Node 20 now fails rather
  than warning. With npm it warns.

### Patch Changes

- Updated dependencies
  - @adastracomputing/aer-emit@0.3.0

## 0.2.0

### Minor Changes

- [`bb2e4dd`](https://github.com/Ad-Astra-Computing/aer/commit/bb2e4dd974f34fbbdb5d6e991c2f5dd31c118430) - remove the value opt-ins that ingest discarded

  `AER_HOOK_RECORD_ARGS`, `AER_MCP_RECORD_ARGS` and `AER_MCP_RECORD_RESULTS` put
  tool argument values and result content on the wire, and AER ingest stored none
  of it: the keys were never on the payload allowlist. Anyone who set one paid the
  privacy cost and got nothing in the record, so all three are gone.

  Both packages now filter every payload against a vendored copy of that
  allowlist before handing it to the sink, so a key the server would discard never
  leaves the machine.

### Patch Changes

- Updated dependencies
  - @adastracomputing/aer-emit@0.2.0

## 0.1.2

### Patch Changes

- Updated dependencies
  - @adastracomputing/aer-emit@0.1.2

## 0.1.1

### Patch Changes

- [`76fa987`](https://github.com/Ad-Astra-Computing/aer/commit/76fa987981cd578bba88f306ac51a120dde7d98b) - README now states the package is ESM only and lists its Node floor. Also
  reworded the `--help` usage text to drop an em dash, with no change in
  behavior.

- [`76fa987`](https://github.com/Ad-Astra-Computing/aer/commit/76fa987981cd578bba88f306ac51a120dde7d98b) - Raise the default shutdown flush budget from 3s to 15s (covers the three
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
