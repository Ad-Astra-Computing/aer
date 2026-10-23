# Fable review: aer-usage-doctor-pause

Reviewed branch `aer-usage-doctor-pause` against `origin/main` in
`/home/agent/code/Ad-Astra-Computing/aer` (commits 016005e..6c92a05):
`aer usage`, `aer doctor` usage-cap check, and graceful `usage_limit_reached`
/ `agent_paused` handling in aer-auto-node and aer-hooks.

No MUST-FIX defects beyond one false README claim. Eight SHOULD-FIX items,
nine advisories. Changed tests pass (CLI 33/33, aer-auto-node 42/42,
aer-hooks refusal 5/5). No secrets, no debug scaffolding, no internal
hostnames. Client sends nothing new to the server (read-only on refusal
bodies), so bodies-off/CONTRACT_VERSION don't apply.

Cross-check against the monorepo server: field names match
(`usage_limit_reached`: error/unit/scope/limit/used/period_end/
recheck_after_seconds/upgrade_url from routes/events.ts:202-210 and
routes/sessions.ts:1058-1066; `agent_paused`: error/agent_id/
recheck_after_seconds from agents/pause.ts:30; `GET /v1/usage` from
routes/usage.ts:67-98).

## MUST-FIX

**1. The CLI README promises a per-agent breakdown the code doesn't
deliver.** `apps/cli/README.md:245`: "There is no per-agent breakdown yet
(the API has not shipped one); this command will show one automatically
once it does." Already false server-side (monorepo `routes/usage.ts:98`
returns `by_agent`, CONTRACT_VERSION 16), and can't come true as written:
`formatUsageHuman` only renders fields it names, so `by_agent` never shows
in text output, only `--json`. Same claim in usage-cmd.ts's header comment.
Fix: either render `by_agent` (sanitizing `agent_name`, tenant-controlled
free text, through `sanitizeForTerminal`), or say `--json` includes it and
the text view doesn't yet.

## SHOULD-FIX

1. aer-auto-node's closing report skips the cooldown and double-logs
   (`session.ts:267-269`); the new test hides this by stubbing
   `closingReport` to return null, which never happens in production.
2. aer-auto-node goes silent for the life of the process on an `open()`
   refusal (most common case: `agent_paused` on session create), with no
   recovery, contradicting the README's own claim of avoiding "going silent
   for good".
3. `recheck_after_seconds` used unbounded in both packages: 0/negative
   removes backoff, huge value silences forever, fractional value gets
   dropped by aer-hooks' `isInt` check on reload.
4. `aer doctor` can report green while an `agent_paused` agent refuses every
   session, since the `agent_id` check only tests `found`, not `status`.
5. Doctor's usage check gives misleading failures on a rejected key (401/403
   reported as "unexpected HTTP") and on a malformed 200 (missing
   `new_sessions_allowed` reported as a fabricated cap block).
6. aer-hooks README overstates retention: outbox is capped at 1000 events
   and drops oldest past that; a weeks-long usage-cap refusal can overflow
   it, but the README says events "are not dropped".
7. aer-hooks' refusal message wrongly promises a later send from the
   worker/final invocation, which skips the cooldown entirely.
8. Several new tests are weaker than they look: a trivial "logs once"
   assertion, `toBeGreaterThanOrEqual(2)` that should be `toBe(2)`, a
   never-fails credential-redaction test, missing worker/final-invocation
   and preamble-refusal coverage.

## ADVISORY

1. `billing_hold` (third 403 from `POST /v1/sessions`) isn't recognised yet;
   dormant while Stripe is unconfigured, add before billing goes live.
2. No shared parity check between the client's two refusal parsers and the
   server's actual shapes (same silent-drift risk AGENTS.md calls out for
   the ingest allowlist).
3. Misleading comment in aer-auto-node/transport.ts:10 (points the wrong
   direction).
4. Doctor prints server strings unsanitised (`state`, `blocked_reason`,
   `upgrade.url`); usage-cmd.ts sanitises but misses `period.*`/`created_at`.
5. `formatUsageHuman` trusts an unvalidated cast; "1 paid users" grammar;
   `events.hard_limit` never shown.
6. `aer usage` silently ignores unknown arguments/subcommands.
7. New doctor usage-check prose placed inside the env-var table, reads like
   a variable entry.
8. Changeset otherwise follows convention; could mention the
   drop-vs-no-drop difference between the two packages.
9. Untracked `.worktrees/` not in `.gitignore`, so a `git add -A` would sweep
   it in (we don't use `-A` here, but worth gitignoring).

## What's sound

No busy loops (both packages gate cleanly without a network call during
cooldown); hook refusals checked before session-gone; cooldown survives
between hook invocations (persisted to disk); unrelated failures untouched;
doctor respects enforcement mode via the server's own `new_sessions_allowed`.
