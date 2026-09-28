---
'@adastracomputing/aer-hooks': patch
---

`aer-hooks install codex` now honours `CODEX_HOME`. Codex reads its
configuration from `$CODEX_HOME` when that is set, but the installer always
wrote `~/.codex/hooks.json`, so on such a machine the install looked finished,
`aer-hooks status` reported the hooks wired, and Codex never ran them. The
installer, `status` and `uninstall` now use `$CODEX_HOME/hooks.json` when
`CODEX_HOME` is an absolute path, including with `--dir` set to your home
directory; an explicit `--dir` anywhere else is unaffected. A relative
`CODEX_HOME`, which Codex resolves against whatever directory it starts in, is
refused by `install` and reported by `status` and `aer doctor`; an empty one
counts as unset. Where AER hooks are still in `~/.codex/hooks.json` while
`CODEX_HOME` points somewhere else, `install` and `status` say so and print
the command that removes them. A `~/.codex` that is a link to `CODEX_HOME`,
or the other way round, is recognised as the same directory.
