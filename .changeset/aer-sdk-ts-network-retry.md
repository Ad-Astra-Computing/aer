---
'@adastracomputing/aer-sdk-ts': patch
---

Sending events now retries a network error (connection refused or reset, a
DNS failure, the request timeout) with the same bounded backoff as a 5xx
answer, as the README states. Previously the first dropped connection
rejected the flush. A failure that outlasts `maxRetries` still rejects
`flush()` and `complete()`, so the caller is told.
