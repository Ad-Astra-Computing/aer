# @adastracomputing/aer-emit

The shared best-effort emit core for AER producers. This is the one place that
knows how to open an AER session, batch events to the ingest endpoint and complete
the session on close. Both `@adastracomputing/aer-mcp-recorder` and
`@adastracomputing/aer-hooks` build on it for consistent behavior between them.

## What it gives you

- `EventSink`: `emit(eventType, payload)` and `close()`.
- `NullSink`: a no-op sink used when AER is not configured.
- `createHttpSink(opts)`: opens a session lazily on the first emit, batches events
  and completes the session on close.
- `sinkFromEnv(env?, overrides?)`: builds a sink from the standard `AER_*` env
  vars, or a `NullSink` when unconfigured.
- `resolvePrincipal(id, kind, display)`: normalizes the on-whose-behalf principal
  (id capped at 128, display at 64, kind in `user|service|ci` defaulting to `user`).

## Non-negotiable properties

Every network call is best-effort. A failed session open, event POST or complete is
swallowed, logged to stderr at most once and never thrown. Emitting is never in the
critical path of the producer's real work. An idle producer that never emits never
touches the network.

## Environment

`AER_API_KEY`, `AER_TENANT_ID`, `AER_AGENT_ID` are required for a live sink;
`AER_ENV_ID`, `AER_BASE_URL`, `AER_AGENT_VERSION`, `AER_PRINCIPAL_ID`,
`AER_PRINCIPAL_KIND` and `AER_PRINCIPAL_DISPLAY` are optional. Miss any of the three
required values and `sinkFromEnv` returns a `NullSink`.

## License

Apache-2.0
