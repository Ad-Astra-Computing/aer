# Changelog

## 0.2.0

### Minor Changes

- [`68d2e1c`](https://github.com/Ad-Astra-Computing/aer/commit/68d2e1cc37e56421bec646b17a7520e90a85685f) - hooks: record Antigravity sessions

  `aer-hooks install antigravity` (or `agy`) wires the same recording into
  Antigravity that Claude Code and Codex CLI already get. Three things differ
  and the adapter handles each. Antigravity has no `SessionStart`, so the first
  `PreInvocation` of a run opens the AER session and later turns do not reopen
  it. Its `Stop` fires on any termination, so the session closes only when the
  payload reports `fullyIdle`, and a `Stop` that omits the flag still closes
  rather than leave a session that never produces a record. Its invocation
  counter starts at zero, so only invocation 0 opens the session. Its payload does
  not name the event, so each registration carries the name on argv.

  Its config is a map of named hook groups at `~/.gemini/config/hooks.json`,
  and it differs from the other two at both levels: no `hooks` wrapper, and the
  command sits directly on the entry rather than in a nested array of typed
  objects. AER owns one group called `aer` and touches no other. Its tool hooks
  do not fire in print mode (`agy -p`), so a headless run records the shape of
  the conversation rather than the individual tool calls. The redaction boundary is unchanged: tool names and argument key
  names, never values. A failed tool arrives as a top-level error string that
  can quote command output, so only the fact of the error is recorded.

  Nothing in the payload carries token counts, so an Antigravity session
  records tools and timing but no LLM usage or cost.
- [`bb2e4dd`](https://github.com/Ad-Astra-Computing/aer/commit/bb2e4dd974f34fbbdb5d6e991c2f5dd31c118430) - hooks: one record per run, and what the run actually did

  `Stop` fires once per assistant turn, and completing the record there split a
  single conversation across several signed AERs. It is now a turn marker and
  `SessionEnd` ends the run. Re-run `aer-hooks install <harness>`: an entry
  written by an earlier release is brought up to date in place, and until it is,
  the old behaviour is kept rather than silently recording nothing.

  Every event now carries the harness, the model, the permission mode, the turn,
  the tool-call id and, on Claude Code, the reasoning effort, plus a position so
  a gap in a record is visible. A shell call is recorded as the program it ran,
  a fetch as the host it reached and a read or write as the file it touched,
  which is the reduction the transcript importer already did. Metadata values
  must be identifier-shaped or they are dropped, so a harness putting a sentence
  in a `reason` field cannot put it in a record.

  `aer-hooks install` warns when AER is already wired in another config layer:
  every matching layer loads, so two registrations record every event twice and
  split the run across records.

  The session markers now declare what the collector was registered for and how
  much of it arrived, so a reader can tell a quiet session from a broken one.

  **Codex users upgrading must re-approve the hook.** Codex records trust
  against the exact command and this release changes it. An untrusted hook is
  skipped silently, with nothing to show that recording stopped. Run `/hooks` in
  Codex and approve the AER entry. The installer, `aer-hooks status` and the
  README all say so.

  The stored session is now dropped only once the record is actually closed. It
  used to be dropped first, so a completion that failed or was killed took the
  ingest token with it and left the session open forever. Event positions are
  reserved before the events are sent rather than after, so two hook processes
  racing for one harness session can no longer take the same number.
- [`bb2e4dd`](https://github.com/Ad-Astra-Computing/aer/commit/bb2e4dd974f34fbbdb5d6e991c2f5dd31c118430) - remove the value opt-ins that ingest discarded

  `AER_HOOK_RECORD_ARGS`, `AER_MCP_RECORD_ARGS` and `AER_MCP_RECORD_RESULTS` put
  tool argument values and result content on the wire, and AER ingest stored none
  of it: the keys were never on the payload allowlist. Anyone who set one paid the
  privacy cost and got nothing in the record, so all three are gone.

  Both packages now filter every payload against a vendored copy of that
  allowlist before handing it to the sink, so a key the server would discard never
  leaves the machine.

### Patch Changes

- [`9cdc013`](https://github.com/Ad-Astra-Computing/aer/commit/9cdc013f7c5cb63a459d65fa0f6c758dff6f301f) - emit: say which collector opened the session

  The API has stored `collector_name` and `collector_version` since migration
  0040, and nothing ever sent them, so the field was null for every session AER
  has opened. `createHttpSink` now takes `collector` and puts it in the
  session-open body, and the hook declares itself. A reader can tell a harness
  recording from a wrapped process without inferring it from the events.
- Updated dependencies
  - @adastracomputing/aer-emit@0.2.0

## 0.1.3

### Patch Changes

- [`aad7172`](https://github.com/Ad-Astra-Computing/aer/commit/aad7172d8bf2fe34410b9005081a3b55316f68fa) - Hooks now record with the `harness` source type instead of the `wrapper` default. A coding harness reports tool lifecycle through its hooks and never watches the network, files or processes, which `wrapper` (the auto-node collector, which does watch the wire) wrongly implied. A harness record is now shown as self-reported for those categories rather than claiming a zero it could not have observed.
- [`d42d8c1`](https://github.com/Ad-Astra-Computing/aer/commit/d42d8c1ed5a348a1de3167e7efa511f3e4d1a9ae) - The installer now writes a hook command the harness can actually run. It resolves `aer-hook` only on a persistent PATH directory, skipping the ephemeral `node_modules/.bin` that npm and npx put in front of the installer's own PATH but never give the harness, and otherwise pins the single-quoted absolute path of the `cli.js` built by this same install. Paths are single-quoted for the shell the harness runs them through, and a path carrying a control character is refused rather than written.

  `aer-hooks status` reports when a wired command no longer resolves. Uninstall and idempotency match only our own hook, so a user's unrelated `node other/cli.js --harness ...` entry is left alone, and `hookCommandResolves` never throws on a hand-written command.

  A lifecycle test runs the built binary through SessionStart, PreToolUse, PostToolUse and Stop against a stand-in API and proves one AER session opens and completes, plus the fail-open promise (exit 0, empty stdout) against an unreachable API.
- Updated dependencies
  - @adastracomputing/aer-emit@0.1.2

## 0.1.2

### Patch Changes

- [`8468e31`](https://github.com/Ad-Astra-Computing/aer/commit/8468e3131ed756c222551f9f11636302913c7647) - Exit 0 when `aer-hooks` is asked for help. `--help`, `-h` and `help` printed
  the usage text but exited 2, so a CI smoke step or a shell script that ran
  `aer-hooks --help` read the binary as broken. An unrecognized command still
  exits 2.

## 0.1.1

### Patch Changes

- [`c8b596a`](https://github.com/Ad-Astra-Computing/aer/commit/c8b596a677a058e5100492c9a7120f77d9baf6c0) - README now states the package is ESM only and lists its Node floor. Also
  rewords a couple of code comments and test names that used an em dash,
  with no change in behavior.

- [`c8b596a`](https://github.com/Ad-Astra-Computing/aer/commit/c8b596a677a058e5100492c9a7120f77d9baf6c0) - Raise the hard timeout from 2.5s to 10s (production session creation measures
  3-4s, so the old budget abandoned most single-shot sessions before they
  saved), and make it configurable with `AER_HOOK_TIMEOUT_MS`. A timeout still
  exits 0 but now writes one stderr diagnostic. Fix a TOCTOU race where two
  concurrent hooks for the same harness session could each open a separate AER
  session: the session-store's read-decide-write sequence is now guarded by a
  per-session lock file, so concurrent hooks converge on one session.
- Updated dependencies [[`5e9231a`](https://github.com/Ad-Astra-Computing/aer/commit/5e9231ada1e4e704e3fb5720eb966acac8f5afec), [`5e9231a`](https://github.com/Ad-Astra-Computing/aer/commit/5e9231ada1e4e704e3fb5720eb966acac8f5afec)]:
  - @adastracomputing/aer-emit@0.1.1

## 0.1.0 - 2026-07-20

First public release. Records the tool activity a coding harness performs into AER,
using the harness's own hooks or plugin API, with redaction by default.

### Added

- **Shell-hook adapter** for Claude Code and OpenAI Codex CLI. One `aer-hook`
  binary normalizes both harnesses' stdin hook payloads (SessionStart, PreToolUse,
  PostToolUse, Stop) into AER events. A conservative installer wires and removes
  only AER's own hook entries in each harness config, backing up the file first.
- **opencode plugin** (`aerOpencodePlugin`). opencode loads in-process plugins
  rather than firing shell hooks, so it gets a native adapter that also captures the
  bash, read, write and edit tools an MCP proxy never sees, plus LLM model and token
  usage read from assistant messages. One AER session per opencode session.
- One AER session per harness session, tracked through a short-lived, owner-only
  cache entry so the tool events of a whole session attach to a single record.

### Privacy boundary

Records tool names, argument key names and result flags only. Argument values and
result content are never recorded unless the operator opts in with
`AER_HOOK_RECORD_ARGS=1`.

### Reliability

Fail-open by design: every hook is wrapped, capped by a hard timeout and exits
cleanly regardless, so it can never break or slow the harness. If AER is
unconfigured it does nothing.
