---
'@adastracomputing/aer-hooks': minor
---

ADR-023 Phase B hooks tier 1. Subagent tool calls now join the lead's
record instead of opening their own: the installer stamps
`--root-session "${CLAUDE_SESSION_ID}"` on every Claude Code registration,
with a pid-alias fallback (up to three ancestor processes) when the
substitution does not propagate. A subagent event that finds no lead is
dropped rather than opening a session of its own, and the drop is counted
as `subagent_events_unattached` on the closing record. Session opens carry
a derived `client_ref` and write a pending marker before the network call,
so a killed opener's next invocation reopens with the identical ref instead
of leaving an orphan; a tool event that loses the lock race polls briefly
and then drops (`events_dropped_budget`) rather than opening a duplicate.
Every event now also carries `harness_agent_id`, not only the subagent
lifecycle markers. `aer-hooks status --json` and the new
`staleRegistrations()` export flag a registration missing `--lifecycle v2`
or `--root-session`, an outdated installed release and an `aer-hook` shadowed
by a nix profile.
