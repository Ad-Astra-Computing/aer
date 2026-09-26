---
'@adastracomputing/aer': minor
---

`aer doctor` now warns when it runs inside a Claude Code tool shell
(`CLAUDECODE=1` or `CLAUDE_CODE_ENTRYPOINT` set) in a project that uses the
Node collector, because the collector stays off there and the program would
record nothing. The warning names `AER_RECORD_IN_AGENT_SHELL=1`, the opt-in.
It does not fail the check. `doctor --json` carries it in a new `warnings`
list.
