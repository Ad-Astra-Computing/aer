---
"@adastracomputing/aer-auto-node": patch
---

Exec command strings are no longer double-captured. Node's `exec()` calls its
own patched `execFile()` internally, and the reentrant capture recorded the
raw shell string (including flags and secrets) in addition to the redacted,
basename-only command.
