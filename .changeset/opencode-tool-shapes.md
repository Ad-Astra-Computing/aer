---
"@adastracomputing/aer-hooks": minor
---

Record opencode's glob, grep and patch-apply tool calls with the same
closed-set detail already recorded for Claude Code: a search pattern
reduces to whether it looked credential-shaped and never the raw text, and a
patch reduces to the file paths its headers name and never the diff content.
opencode's todo and task tools still record only the tool name, since their
only meaningful arguments are free text.
