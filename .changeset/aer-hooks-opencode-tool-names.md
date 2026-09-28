---
'@adastracomputing/aer-hooks': patch
---

The opencode plugin now records a tool name only when it is a string of at
most 200 UTF-16 code units with no control characters. Any other name, such
as an oversized MCP tool name, is recorded as `(unrecordable tool name)` and
each such call adds a `collector.report` marker with phase
`tool_name_replaced`, so the tool event is no longer refused by the AER API.
