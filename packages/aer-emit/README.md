# @adastracomputing/aer-emit

The shared best-effort emit core for AER producers. This is the one place that
knows how to open an AER session, batch events to the ingest endpoint and complete
the session on close. Both `@adastracomputing/aer-mcp-recorder` and
`@adastracomputing/aer-hooks` build on it for consistent behavior between them.

ESM only: use `import`, not `require`. Requires Node 22 or newer. To install
it directly rather than through one of those two:
`npm install @adastracomputing/aer-emit`.

Moving from an earlier release? See [Upgrading](https://github.com/Ad-Astra-Computing/aer/blob/main/docs/upgrading.md#aer-emit).

## What it gives you

- `EventSink`: `emit(eventType, payload, eventId?)` and `close()`. `eventId` lets a
  caller that can derive a stable id for an event make re-emitting it idempotent at
  ingest; omitted, the sink assigns a fresh random id.
- `NullSink`: a no-op sink used when AER is not configured.
- `createHttpSink(opts)`: opens a session lazily on the first emit, batches events
  and completes the session on close. `opts.clientRef` (paired with
  `deriveClientRef`) makes a repeated session open reuse the running session
  instead of minting a duplicate. `opts.onComplete(ok)` reports whether the
  closing `/complete` call succeeded. `opts.collector` names which collector
  opened the session, for a reader that needs to tell a harness recording from a
  wrapped process.
- `deriveClientRef(harness, rootHarnessSessionId, agentId)`: derives the
  deterministic `client_ref` a caller passes to `createHttpSink`.
- `sinkFromEnv(env?, overrides?)`: builds a sink from the standard `AER_*` env
  vars, or a `NullSink` when unconfigured.
- `resolvePrincipal(id, kind, display)`: normalizes the on-whose-behalf principal
  (id capped at 128, display at 64, kind in `user|service|ci` defaulting to `user`).

## Non-negotiable properties

Every network call is best-effort. A failed session open, event POST or complete is
swallowed, logged to stderr at most once and never thrown. Emitting is never in the
critical path of the producer's real work. An idle producer that never emits never
touches the network. A batch the API does not accept is dropped, never handed back
to your code. A network error or a 429, 502, 503 or 504 gets three retries, then the
batch is dropped; any other non-2xx drops the batch at once; a 401, 403, 404 or 409
disables the sink, so every later event is dropped too. Each of these prints one
stderr line the first time it happens in a process and nothing on later occurrences,
so a run that looked clean on stderr can still be missing events. `close()` still
resolves and `onComplete` still reports `true` once `/complete` succeeds.

## Environment

`AER_API_KEY`, `AER_TENANT_ID`, `AER_AGENT_ID` are required for a live sink;
`AER_ENV_ID`, `AER_BASE_URL`, `AER_AGENT_VERSION`, `AER_PRINCIPAL_ID`,
`AER_PRINCIPAL_KIND` and `AER_PRINCIPAL_DISPLAY` are optional. Miss any of the three
required values and `sinkFromEnv` returns a `NullSink`. `AER_ENV_ID` is not checked
there, but the API refuses to open a session without it, so a live sink built
without it records nothing and says so once on stderr.

## License

Apache-2.0
