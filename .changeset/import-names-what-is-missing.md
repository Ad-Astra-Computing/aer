---
'@adastracomputing/aer': patch
---

`aer import claude-code` now says what is wrong instead of printing the whole
usage text. It names each unset variable and where to find its value, reads
the tenant, agent and environment ids from `aer.config.json` when they are not
in the environment, and defaults the API to https://api.aer.run. Run without a
file, it says where Claude Code keeps transcripts and lists the newest for the
current directory. A file with no session activity, such as
`~/.claude/history.jsonl`, is refused before a session is created, rather than
producing a signed record of an empty session.
