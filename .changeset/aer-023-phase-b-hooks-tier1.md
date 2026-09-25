---
'@adastracomputing/aer-hooks': minor
---

Subagent tool calls now join the lead's record instead of opening their
own. The hook finds the lead through `CLAUDE_CODE_SESSION_ID` in its
environment, with a process-alias fallback (up to three ancestor processes,
checked against start time, agent and base URL); `--root-session <id>`
overrides both. A subagent event that finds no lead is dropped rather than
opening a session of its own, and the drop is counted as
`subagent_events_unattached` on the closing record. Session opens carry a
derived `client_ref` and write a pending marker before the network call, so
a killed opener's next invocation reopens with the identical ref instead of
leaving an orphan; a tool event that loses the lock race polls briefly and
then drops (`events_dropped_budget`) rather than opening a duplicate. Every
event now also carries `harness_agent_id`. `aer-hooks status --json` and the
new `staleRegistrations()` export flag a registration missing
`--lifecycle v2`, an outdated installed release and an `aer-hook` shadowed
by a nix profile. Re-run `aer-hooks install claude-code` to pick up the
longer SessionStart timeout.
