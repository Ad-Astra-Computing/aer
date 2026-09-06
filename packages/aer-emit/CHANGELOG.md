# Changelog

## 0.1.1

### Patch Changes

- [`7df22a1`](https://github.com/Ad-Astra-Computing/aer/commit/7df22a15fef860bdce9fab905a4b3901ec4d555a) Thanks [@jasonodoom](https://github.com/jasonodoom)! - The HTTP sink now waits for every in-flight flush before completing a
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

- [`7df22a1`](https://github.com/Ad-Astra-Computing/aer/commit/7df22a15fef860bdce9fab905a4b3901ec4d555a) Thanks [@jasonodoom](https://github.com/jasonodoom)! - `resolveSinkOptionsFromEnv` now accepts `AER_TENANT_API_KEY` as a fallback
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
