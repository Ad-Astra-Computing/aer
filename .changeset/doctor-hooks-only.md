---
"@adastracomputing/aer": patch
---

doctor: do not fail for hooks-only setups

`aer doctor` always ran the Node auto-instrumentation checks (aer-auto-node
installed, NODE_OPTIONS wired, aer.config.json identity), so a user who
records through the coding-harness hooks or the SDK saw an overall FAILED for
a collector they never chose. Those checks now run only when the Node
collector is actually set up here; otherwise doctor reports it as an optional,
not-configured line and passes on the live API and auth checks. A present but
broken Node-collector setup still fails.
