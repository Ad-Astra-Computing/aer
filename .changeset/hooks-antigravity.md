---
"@adastracomputing/aer-hooks": minor
---

hooks: record Antigravity sessions

`aer-hooks install antigravity` (or `agy`) wires the same recording into
Antigravity that Claude Code and Codex CLI already get. Three things differ
and the adapter handles each. Antigravity has no `SessionStart`, so the first
`PreInvocation` of a run opens the AER session and later turns do not reopen
it. Its `Stop` fires on any termination, so the session closes only when the
payload reports `fullyIdle`, and a `Stop` that omits the flag still closes
rather than leave a session that never produces a record. Its payload does
not name the event, so each registration carries the name on argv.

Its config is a map of named hook groups at `~/.gemini/config/hooks.json`
with no `hooks` wrapper. AER owns one group called `aer` and touches no
other. The redaction boundary is unchanged: tool names and argument key
names, never values. A failed tool arrives as a top-level error string that
can quote command output, so only the fact of the error is recorded.

Nothing in the payload carries token counts, so an Antigravity session
records tools and timing but no LLM usage or cost.
