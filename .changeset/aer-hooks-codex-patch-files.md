---
'@adastracomputing/aer-hooks': patch
---

A file Codex writes is now recorded. Codex edits files through `apply_patch`,
whose one argument is the whole patch, so the record showed the tool call and
nothing about which file changed. The hook now reads only the patch's file
headers, inside its `*** Begin Patch` and `*** End Patch` lines, and records a
`file.written` event for each file added, updated, deleted or moved to,
resolved against the session's working directory. A patch naming more than 16
files records the first 16 and puts the number it named in `count` on its
`tool.started` event, so the record says it is incomplete. The patch content
is never read into the record.
