---
'@adastracomputing/aer-emit': patch
---

The README now documents the sink options 0.4.0 added and left
undocumented: the optional `eventId` argument to `emit` and the
lowercase-UUID shape it must have, `batchSize`, `maxPending` and
`requestTimeoutMs`, `clientRef` and `deriveClientRef` for reusing a running
session on a repeated open, `session`, `completeOnClose` and `onOpen` for
attaching to a session another process owns, `onComplete` and `collector`
on `createHttpSink` and what happens to a batch the API does not accept
(which codes are retried, which drop the batch or disable the sink, and
that the stderr line prints only once). It also notes that a live sink
built without `AER_ENV_ID` records nothing rather than working with a
missing field.
