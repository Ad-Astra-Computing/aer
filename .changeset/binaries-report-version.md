---
'@adastracomputing/aer-hooks': patch
'@adastracomputing/aer': patch
---

Answer `--version`

Neither binary could say which version it was. That is the first question a
support conversation asks when a record looks wrong, and the answer was
unavailable from the machine that produced it. `aer --version`, `aer-hooks
--version` and `aer-hook --version` now print the installed version and exit 0,
and `-V` is accepted for both spellings people reach for.

The version is read from the package manifest a release bumps, never restated
in the source, so it cannot drift a release behind.
