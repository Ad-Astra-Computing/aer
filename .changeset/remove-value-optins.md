---
"@adastracomputing/aer-hooks": minor
"@adastracomputing/aer-mcp-recorder": minor
---

remove the value opt-ins that ingest discarded

`AER_HOOK_RECORD_ARGS`, `AER_MCP_RECORD_ARGS` and `AER_MCP_RECORD_RESULTS` put
tool argument values and result content on the wire, and AER ingest stored none
of it: the keys were never on the payload allowlist. Anyone who set one paid the
privacy cost and got nothing in the record, so all three are gone.

Both packages now filter every payload against a vendored copy of that
allowlist before handing it to the sink, so a key the server would discard never
leaves the machine.
