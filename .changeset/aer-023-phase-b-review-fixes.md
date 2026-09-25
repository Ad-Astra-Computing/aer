---
'@adastracomputing/aer-hooks': patch
'@adastracomputing/aer-emit': patch
---

The installed `aer-hooks` version is baked in at build time, so a bundled
CLI reports it correctly. The session open is retried without `client_ref`
only when the server's 400 names that field, and a late write from a stalled
opener can no longer move the stored event position backwards.
