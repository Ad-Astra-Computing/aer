---
'@adastracomputing/aer-hooks': minor
---

The record of a session now completes when the harness allows the session's last
hook only a short time. Configs written by `aer-hooks install` already gave
Claude Code's SessionEnd a 15-second timeout and completed; what is fixed is a
Claude Code entry without a `timeout` (a hand-written or edited config), which
`claude -p` cancelled after 1.5 seconds, and Codex, which caps SessionEnd hooks
at 3 seconds. Both left the session open until the server closed it hours later,
without a summary.

- The installer now writes `--end-budget-ms` on the entry that ends a session
  (Claude Code and Codex SessionEnd, Antigravity `Stop`). The hook delivers for
  that long itself. Run `aer-hooks install` again to add it.
- The hook also starts a short-lived background process that outlives the
  harness and finishes what is left: all of it when no budget is declared, in
  which case the hook itself stops 1.2 seconds after it started. The process
  gets only the variables it needs, writes its notes to `drain.log` in the state
  directory and exits within a minute. A container that ends with the harness
  ends it too, and on Windows none is started.
- The closing report is no longer dropped after repeated failed sends; a failure
  where no answer came at all no longer counts toward that limit.
