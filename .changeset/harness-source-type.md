---
"@adastracomputing/aer-hooks": patch
"@adastracomputing/aer-emit": patch
---

Hooks now record with the `harness` source type instead of the `wrapper` default. A coding harness reports tool lifecycle through its hooks and never watches the network, files or processes, which `wrapper` (the auto-node collector, which does watch the wire) wrongly implied. A harness record is now shown as self-reported for those categories rather than claiming a zero it could not have observed.
