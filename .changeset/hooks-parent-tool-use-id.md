---
'@adastracomputing/aer-hooks': patch
---

Record which tool call spawned a subagent

A nested agent's steps had nothing tying them back to the call that started
them, so a record could show that a subagent ran but not who sent it. Where a
harness sends `parent_tool_use_id`, it is now recorded and signed into the
bundle as a `spawned` edge, and the console draws the subagent as its own lane
beside the main thread.

Metadata only, in keeping with bodies-off: an identifier, never the call's
arguments or its result. No harness documents this field today, so it is
recorded only where one sends it.
