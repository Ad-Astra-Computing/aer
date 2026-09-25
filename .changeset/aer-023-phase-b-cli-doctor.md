---
'@adastracomputing/aer': minor
---

`aer doctor` now folds in the hooks staleness report (ADR-023 B3): a
registration missing `--lifecycle v2` or `--root-session`, an outdated
installed `aer-hooks`, or a nix-profile `aer-hook` ahead of the project
install, each printed as a `WARN` with the exact fix command and carried
under `hooks.stale_registrations` in `--json` output.
