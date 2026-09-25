---
'@adastracomputing/aer-emit': minor
---

`EventSink.emit` takes an optional third `eventId` argument. A caller that
can derive a stable id for an event, such as one keyed off a transcript
message id, can now make re-emitting it idempotent at ingest instead of
getting a fresh random id every time. Omitted, behavior is unchanged. A
supplied id that is not a lowercase RFC 4122 UUID is treated as not
supplied, so the generator still runs rather than sending a value ingest
would reject the whole event over.
