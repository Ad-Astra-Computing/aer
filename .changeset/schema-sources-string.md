---
"@adastracomputing/aer-verify": patch
---

The bundle `correlation.sources` field parses a bounded string rather than a fixed enum, so a record sealed with a source type newer than a reader's schema still parses. Event ingest keeps the strict enum, where both ends are controlled. This matches the server and retires a rollout hazard when a new source type is added.
