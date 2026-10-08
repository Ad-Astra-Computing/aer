---
"@adastracomputing/aer-hooks": minor
"@adastracomputing/aer-mcp-recorder": patch
---

aer-hooks now records two new event types, human.input and approval.decided, so a completed session's record can show how much a human was supervising it. Install or doctor again to pick up the two additional hook registrations this needs.

aer-mcp-recorder's vendored ingest allowlist picked up the two new keys to stay in sync; it does not send them itself.
