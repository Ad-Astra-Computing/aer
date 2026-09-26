---
'@adastracomputing/aer-hooks': patch
---

`aer doctor` and `aer-hooks status` no longer call an `aer-hook` binary
"wired" when nothing actually points at it: they now say it was found "on
PATH" instead, and reserve "wired" for a binary a harness config really
references. An install too old to print its own version is reported as
unreadable rather than as a specific version number nobody actually read off
it, and the message still tells you to upgrade.
