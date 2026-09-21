---
"@adastracomputing/aer-auto-node": patch
---

collector: join the records one run produces

A process that spawns worker threads gets a collector per thread and a signed
record per thread. Every `collector.report` now carries a run id, shared across
the threads and child processes of one run, plus the pid and thread it was
written on, so the records can be put back together.

A quiet adapter is no longer reported as `idle` when the session made
model-shaped requests to hosts no adapter claims. It reads `unverifiable`,
because `idle` would be a signed claim that no model traffic happened.
