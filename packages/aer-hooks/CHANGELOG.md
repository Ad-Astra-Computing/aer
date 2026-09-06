# Changelog

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
