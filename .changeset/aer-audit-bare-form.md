---
'@adastracomputing/aer': patch
---

`aer audit` and `aer audit --limit N` now list the tenant audit log as the
usage text describes, instead of exiting with "needs a subcommand".
`aer audit list` keeps working, and an unknown subcommand is reported as a
usage error.
