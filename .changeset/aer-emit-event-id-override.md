---
'@adastracomputing/aer-emit': patch
---

`EventSink.emit` takes an optional third `eventId` argument. A caller that
can derive a stable id for an event, such as one keyed off a transcript
message id, can now make re-emitting it idempotent at ingest instead of
getting a fresh random id every time. Omitted, behavior is unchanged.
