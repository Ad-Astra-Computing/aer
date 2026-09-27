---
'@adastracomputing/aer-hooks': minor
---

The hooks can now read their AER credentials from a file instead of the shell
environment: `aer-hooks install <harness> --env-file <path>` writes the file
into every hook command, and the hook reads its `AER_*` lines for its own use
only, never exporting them to anything it starts. Keeping the key out of the
shell profile stops it reaching every command the agent runs, where anything
that loads an AER emitter would record under the harness agent. The file must
be a plain file owned by you and readable by no one else; anything looser is
refused with a message that never shows its contents, and the installer
refuses it up front. `AER_ENV_FILE` works in place of the flag. `aer-hooks
status` and `aer doctor` now warn when an AER key is exported in the shell
while hooks are wired.
