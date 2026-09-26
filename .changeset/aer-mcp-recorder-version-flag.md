---
'@adastracomputing/aer-mcp-recorder': patch
---

`aer-mcp-recorder --version` (and `-V`) now prints the installed version
instead of falling through to the usage text, matching every other AER
binary. The version reported also now tracks the package's own release
rather than a hand-written number that had drifted out of date.
