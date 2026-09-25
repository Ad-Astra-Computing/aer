---
'@adastracomputing/aer': patch
---

`aer import claude-code` now reads model + token counts off a transcript
assistant message through the same vendored helper aer-hooks uses for its
live Claude Code capture, so the two paths cannot drift on what counts as
bodies-off. No output change.
