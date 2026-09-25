---
'@adastracomputing/aer': minor
---

Add `aer login`, `aer logout`, `aer whoami` and `aer link`. `aer login` runs
the device authorization flow, prints a URL and a code to type, and saves the
resulting tenant key to `~/.config/aer/credentials.json` (0700/0600, atomic,
symlink-refusing). `aer link` writes `aer.config.json` for the current
project from that session, with an interactive agent picker on a terminal.
Every tenant command, including `aer import claude-code`, now falls back to
these credentials when no environment variable or `aer.config.json` field is
set, so a machine only needs `aer login` once and each project only needs
`aer link` once.
