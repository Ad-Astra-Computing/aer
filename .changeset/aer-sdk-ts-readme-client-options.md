---
'@adastracomputing/aer-sdk-ts': patch
---

The README now documents two client options that were missing from the
table: `requestTimeoutMs` (the per-request timeout) and `onIngestResult`
(a callback for the result of every events POST, including ones the
client sends on its own from a batch or the flush timer).
