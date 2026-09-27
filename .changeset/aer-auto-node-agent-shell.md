---
'@adastracomputing/aer-auto-node': minor
---

The collector no longer records a process started inside a Claude Code tool
shell (`CLAUDECODE=1` or `CLAUDE_CODE_ENTRYPOINT` set) unless you set
`AER_RECORD_IN_AGENT_SHELL=1`. Claude Code exports its own environment,
including any `AER_*` credentials it was given, into every command it runs,
so a test suite or script an agent started there was recorded into the
agent's account as a separate short session. The collector now prints one
line explaining why it did not start.
