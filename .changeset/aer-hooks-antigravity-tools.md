---
'@adastracomputing/aer-hooks': patch
---

Antigravity tool calls are now recorded. `aer-hooks install antigravity` wrote
the tool events in the flat form Antigravity uses for its invocation events,
and Antigravity loads that form for a tool event without complaint but never
runs it, so a run recorded its turns and none of its tool calls. The tool
events are now written as a matcher group, the form Antigravity fires them
from; run `aer-hooks install antigravity` again to update an existing
registration. The hook also reads the argument names Antigravity actually
sends (`CommandLine`, `AbsolutePath`, `TargetFile`, `Url`), so a shell line is
reduced to its programs and hosts, and a file read or write records its path,
as they already were for Claude Code and Codex.
Until it is, `aer-hooks status` and `aer doctor` report such a registration
as recording no tool calls and name that command.
