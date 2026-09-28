---
'@adastracomputing/aer-emit': patch
---

The README now documents the sink options that shipped since the last
release: the optional `eventId` argument to `emit`, `clientRef` and
`deriveClientRef` for reusing a running session on a repeated open,
`onComplete` and `collector` on `createHttpSink` and what happens to a
batch the API does not accept (which codes are retried, which drop the batch
or disable the sink, and that the stderr line prints only once).
