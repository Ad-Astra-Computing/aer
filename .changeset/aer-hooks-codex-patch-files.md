---
'@adastracomputing/aer-hooks': patch
---

A file Codex writes is now recorded. Codex edits files through `apply_patch`,
whose one argument is the whole patch, so the record showed the tool call and
nothing about which file changed. The hook now reads only the patch's file
headers and records a `file.written` event for each file added, updated,
deleted or moved to (up to 16 per patch), resolved against the session's
working directory. The patch content is never read into the record.
