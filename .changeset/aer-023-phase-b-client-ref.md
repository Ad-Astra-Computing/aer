---
'@adastracomputing/aer-emit': minor
---

Add `deriveClientRef` and a `clientRef` sink option (ADR-023 A1/B2). A
repeated `POST /v1/sessions` open with the same `client_ref` while the prior
session is still running reuses it instead of minting a duplicate, closing
the race that produced empty orphaned sessions. Against a server that
predates the field, the open retries once without `client_ref` rather than
failing outright.
