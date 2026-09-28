---
'@adastracomputing/aer-hooks': patch
---

`aer-hooks install codex` now honours `CODEX_HOME`. Codex reads its
configuration from `$CODEX_HOME` when that is set, but the installer always
wrote `~/.codex/hooks.json`, so on such a machine the install looked finished,
`aer-hooks status` reported the hooks wired, and Codex never ran them. The
installer, `status` and `uninstall` now use `$CODEX_HOME/hooks.json` when
`CODEX_HOME` is an absolute path; an explicit `--dir` is unaffected.
