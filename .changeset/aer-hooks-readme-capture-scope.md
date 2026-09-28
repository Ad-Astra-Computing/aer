---
'@adastracomputing/aer-hooks': patch
---

The README now describes what the hooks actually capture: a shell
command's programs and hosts, a file read or write's path, a web fetch's
host and scheme and a Claude Code transcript's model, token counts and a
few identifying fields, alongside the tool-name-and-argument-key rule that
still covers everything else. It also documents that a refused
`--env-file` falls back to the process environment with a warning rather
than recording nothing, and fixes the env-file example to name all four
required variables.
