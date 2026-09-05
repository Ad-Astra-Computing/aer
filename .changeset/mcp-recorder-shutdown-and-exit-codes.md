---
"@adastracomputing/aer-mcp-recorder": patch
---

Raise the default shutdown flush budget from 3s to 15s (covers the three
sequential prod round trips at close: open, events, complete), make it
configurable with `AER_CLOSE_TIMEOUT_MS`, and exit 70 with a stderr diagnostic
when it is exceeded instead of a silent 0. A signal-killed child now reports
`128 + signal number` instead of a false success. `AER_AGENT_VERSION` defaults
to `mcp-recorder/<package version>` when unset, since the API requires an
agent version on every session.
