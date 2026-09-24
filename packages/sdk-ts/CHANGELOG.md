# Changelog

## 0.2.0

### Minor Changes

- [`5d8c488`](https://github.com/Ad-Astra-Computing/aer/commit/5d8c4884b029fdc66566df9fbd36217e57de1a89) - **Breaking:** the minimum supported Node is now 22, up from 20.

  Node 20 reached end of life on 30 April 2026 and receives no further security
  fixes, so these packages no longer claim to support it. Node 22 is supported
  until 30 April 2027 and remains the floor until then. Node 24 is the current
  long-term support release and is recommended.

  With pnpm, which enforces this field, installing on Node 20 now fails rather
  than warning. With npm it warns.

## 0.1.2

### Patch Changes

- [`5d17a58`](https://github.com/Ad-Astra-Computing/aer/commit/5d17a58fd11a5b0c552ad0c4c90816319f13ea62) - README now states the package is ESM only and lists its Node floor.

- [`5d17a58`](https://github.com/Ad-Astra-Computing/aer/commit/5d17a58fd11a5b0c552ad0c4c90816319f13ea62) - close() now always waits for a flush already in progress, even when the
  buffer has already drained, so a background or size-triggered flush can no
  longer lose its own batch to a race with the caller. Every POST is now
  capped at 500 events regardless of the configured batchSize, matching the
  server's own per-batch limit. A new onIngestResult callback surfaces the
  accepted/rejected counts of a flush the caller did not itself await, so a
  207 partial accept from an internally-triggered flush is no longer invisible.
  Requests now honor a configurable requestTimeoutMs (default 10 seconds) via
  AbortController instead of relying on the injected fetch's own timeout
  behavior. IngestResult and CompleteResult now include the additional fields
  the API actually returns.

## 0.1.1 - 2026-07-26

- Documentation and packaging updates: examples target `api.aer.run`, repository
  links point at the public package repository, Node >= 20 declared in engines.
  No runtime changes.

## 0.1.0 - 2026-07-11

Initial release. Typed client for the AER ingest API: batched event emission
with automatic flushing, plus session complete and abort.
