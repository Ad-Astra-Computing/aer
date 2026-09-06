# Changelog

## 0.1.2

### Patch Changes

- [`84b0779`](https://github.com/Ad-Astra-Computing/aer/commit/84b0779511a9c41b2d7ca53fcbde355d32b73e1e) Thanks [@jasonodoom](https://github.com/jasonodoom)! - README now states the package is ESM only and lists its Node floor.

- [`84b0779`](https://github.com/Ad-Astra-Computing/aer/commit/84b0779511a9c41b2d7ca53fcbde355d32b73e1e) Thanks [@jasonodoom](https://github.com/jasonodoom)! - close() now always waits for a flush already in progress, even when the
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
