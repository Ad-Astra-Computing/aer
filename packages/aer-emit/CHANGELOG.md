# Changelog

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
