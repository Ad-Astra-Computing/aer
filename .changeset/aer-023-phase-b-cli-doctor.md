---
'@adastracomputing/aer': minor
---

`aer doctor` now folds in the hooks staleness report: a registration
missing `--lifecycle v2`, an outdated installed `aer-hooks` or a
nix-profile `aer-hook` ahead of the project install, each printed as a
`WARN` with the exact fix command and carried under
`hooks.stale_registrations` in `--json` output.
