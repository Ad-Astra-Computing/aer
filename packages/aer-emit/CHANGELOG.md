# Changelog

## 0.3.0

### Minor Changes

- [`5d8c488`](https://github.com/Ad-Astra-Computing/aer/commit/5d8c4884b029fdc66566df9fbd36217e57de1a89) - **Breaking:** the minimum supported Node is now 22, up from 20.

  Node 20 reached end of life on 30 April 2026 and receives no further security
  fixes, so these packages no longer claim to support it. Node 22 is supported
  until 30 April 2027 and remains the floor until then. Node 24 is the current
  long-term support release and is recommended.

  With pnpm, which enforces this field, installing on Node 20 now fails rather
  than warning. With npm it warns.

## 0.2.0

### Minor Changes

- [`9cdc013`](https://github.com/Ad-Astra-Computing/aer/commit/9cdc013f7c5cb63a459d65fa0f6c758dff6f301f) - emit: say which collector opened the session

  The API has stored `collector_name` and `collector_version` since migration
  0040, and nothing ever sent them, so the field was null for every session AER
  has opened. `createHttpSink` now takes `collector` and puts it in the
  session-open body, and the hook declares itself. A reader can tell a harness
  recording from a wrapped process without inferring it from the events.
- [`6ad72d2`](https://github.com/Ad-Astra-Computing/aer/commit/6ad72d201264b25df5406fa1001635743422240e) - sink: report whether the session actually completed

  `onComplete(ok)` fires on close when this sink owns the completion, mirroring
  `onOpen`. A failed `POST /complete` was previously only a line on stderr, so a
  caller holding recovery state had no way to know the record was not closed and
  would discard what it needed to finish the session later.

## 0.1.2

### Patch Changes

- [`aad7172`](https://github.com/Ad-Astra-Computing/aer/commit/aad7172d8bf2fe34410b9005081a3b55316f68fa) - Hooks now record with the `harness` source type instead of the `wrapper` default. A coding harness reports tool lifecycle through its hooks and never watches the network, files or processes, which `wrapper` (the auto-node collector, which does watch the wire) wrongly implied. A harness record is now shown as self-reported for those categories rather than claiming a zero it could not have observed.

## 0.1.1

### Patch Changes

- [`5e9231a`](https://github.com/Ad-Astra-Computing/aer/commit/5e9231ada1e4e704e3fb5720eb966acac8f5afec) - The HTTP sink now waits for every in-flight flush before completing a
  session, so a batch that was still posting when close() ran can no longer be
  lost to a race with the completion call. Large synchronous bursts are split
  into requests of at most 500 events instead of one oversized request the
  server would reject outright. A 207 partial accept, or a 202 that reports
  dropped payload keys, now logs a one-time diagnostic instead of being
  silently discarded. Transient failures (429 with Retry-After, 502, 503, 504,
  and network errors) retry the same batch up to three times with backoff
  before that batch is dropped and logged once; the sink is still disabled
  outright on 401, 403, 404, and 409, since those mean the credential or
  session itself is gone. The in-memory buffer is now capped at 10000 events,
  dropping the oldest on overflow with a single diagnostic, and a request
  timeout (configurable, default 10 seconds) aborts a hanging request instead
  of hanging forever. A beforeExit handler flushes whatever is buffered on
  process exit, best effort; callers still need close() to complete a session.

- [`5e9231a`](https://github.com/Ad-Astra-Computing/aer/commit/5e9231ada1e4e704e3fb5720eb966acac8f5afec) - `resolveSinkOptionsFromEnv` now accepts `AER_TENANT_API_KEY` as a fallback
  for `AER_API_KEY`, matching the CLI and the documented behavior of the
  opencode plugin. Previously only `AER_API_KEY` was read, so a producer
  configured with `AER_TENANT_API_KEY` alone recorded nothing, silently.
  
  README now also states the package is ESM only and lists its Node floor.

## 0.1.0 - 2026-07-20

First public release. The shared best-effort emit core behind
`@adastracomputing/aer-hooks` and `@adastracomputing/aer-mcp-recorder`, so those
packages record through one code path with no drift.

### Added

- `createHttpSink`: an `EventSink` that lazily opens an AER session on the first
  event, batches events to the ingest endpoint and completes the session on close.
  It can also attach to a session already opened by another process.
- `NullSink`: a no-op sink used when emit is unconfigured.
- Environment resolution helpers and the shared `Principal` type.

### Reliability

- Every network operation is best-effort. A failed session open, event post or
  completion is swallowed, logged at most once and never thrown, so emitting is
  never in the critical path of the producer's real work.
- The wire format matches the AER ingest API exactly: sessions open against
  `agent_session_id`, events post as a bare array and each event carries the full
  `event_id`, `agent_session_id`, `source_type` and `timestamp_observed` shape the
  server validates.
