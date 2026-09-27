---
'@adastracomputing/aer-emit': patch
---

The README now documents the sink options that shipped since the last
release: the optional `eventId` argument to `emit`, `clientRef` and
`deriveClientRef` for reusing a running session on a repeated open,
`onComplete` and `collector` on `createHttpSink`, and what happens to a
batch that keeps failing (dropped after three retries or a 4xx, with one
stderr line).
