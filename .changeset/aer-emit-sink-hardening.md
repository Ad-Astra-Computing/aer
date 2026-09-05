---
"@adastracomputing/aer-emit": patch
---

The HTTP sink now waits for every in-flight flush before completing a
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
