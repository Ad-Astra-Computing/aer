---
"@adastracomputing/aer-sdk-ts": patch
---

close() now always waits for a flush already in progress, even when the
buffer has already drained, so a background or size-triggered flush can no
longer lose its own batch to a race with the caller. Every POST is now
capped at 500 events regardless of the configured batchSize, matching the
server's own per-batch limit. A new onIngestResult callback surfaces the
accepted/rejected counts of a flush the caller did not itself await, so a
207 partial accept from an internally-triggered flush is no longer invisible.
Requests now honor a configurable requestTimeoutMs (default 10 seconds) via
AbortController instead of relying on the injected fetch's own timeout
behavior. IngestResult and CompleteResult now include the additional fields
the API actually returns.
