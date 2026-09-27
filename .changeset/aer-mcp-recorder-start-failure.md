---
'@adastracomputing/aer-mcp-recorder': patch
---

A wrapped command that cannot start is now reported instead of exiting 0 in
silence. `aer-mcp-recorder` prints one line to stderr naming the command and
exits `127` when it does not exist or `126` when it cannot be executed, the
same codes a shell uses. Recording failures still never change the exit code.
