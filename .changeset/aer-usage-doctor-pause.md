---
"@adastracomputing/aer": minor
"@adastracomputing/aer-auto-node": minor
"@adastracomputing/aer-hooks": patch
---

Add `aer usage`, a new CLI command that reads `GET /v1/usage` and prints
this tenant's plan, period and events/sessions usage against their limits
in plain text by default, or the raw response with `--json`. `aer doctor`
now checks the tenant's usage cap too, failing with the blocked reason and
upgrade URL when the API currently refuses new sessions.

`aer-auto-node`'s HTTP transport now recognizes the AER API's two
structured usage refusals (a tenant's usage cap reached, or an agent paused
by the tenant operator) and throws the new exported `AerRefusalError`
instead of a generic error, with a clear plain-English message. The session
manager backs off for the time the API gave it instead of retrying on every
later batch, so a long-running session does not hammer the API while a
tenant is over its cap or an agent is paused; events captured during that
window are dropped (not queued, since the window can be long) and counted
toward the closing report's delivery stats.

`aer-hooks` now gives the same two refusals the same treatment: a usage cap
or paused-agent 403 is never mistaken for the session being gone (which
previously dropped and reopened it on every later hook invocation), and the
hook backs off for the time the API gave it. Queued events wait for that
retry rather than being dropped outright, but the outbox's ordinary 1,000-
event cap still applies underneath a long wait, with the usual
`events_dropped_budget` accounting. One clear log line covers the whole
episode rather than one per hook invocation.
