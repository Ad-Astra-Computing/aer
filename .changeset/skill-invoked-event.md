---
"@adastracomputing/aer-hooks": minor
---

Record a Claude Code Skill call as a new skill.invoked event, carrying the
invoked skill's own name only, never the arguments it was invoked with. A
Skill call still gets the usual tool.started/tool.completed events alongside
it; this adds the typed, bodies-off-safe detail the server already has a
schema for.
