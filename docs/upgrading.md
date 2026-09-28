# Upgrading

What changes when you move each AER package from its previous `latest`
release to the current one, and what to do about it. Most changes need no
action. The ones that do are listed first in each section.

| Package | From | To |
| --- | --- | --- |
| [`@adastracomputing/aer`](#aer-cli) | 0.1.4 | 0.4.0 |
| [`@adastracomputing/aer-hooks`](#aer-hooks) | 0.1.3 | 0.5.0 |
| [`@adastracomputing/aer-mcp-recorder`](#aer-mcp-recorder) | 0.1.2 | 0.3.2 |
| [`@adastracomputing/aer-auto-node`](#aer-auto-node) | 0.3.0 | 0.5.0 |
| [`@adastracomputing/aer-emit`](#aer-emit) | 0.1.2 | 0.4.0 |
| [`@adastracomputing/aer-sdk-ts`](#aer-sdk-ts) | 0.1.2 | 0.2.1 |
| [`@adastracomputing/aer-resource-node`](#aer-resource-node) | 0.1.2 | 0.3.0 |
| [`@adastracomputing/aer-mcp-guard`](#aer-mcp-guard) | 0.1.2 | 0.3.0 |
| [`@adastracomputing/aer-verify`](#aer-verify) | 0.1.2 | 0.2.0 |

Move them together. Packages that depend on each other pin exact versions,
so upgrading one while leaving another behind can mix two generations of the
same behaviour.

Records made by an earlier release are not rewritten. Everything below
describes new records only.

## Every package: Node 22 or newer

Node 20 has reached end of life and is no longer supported. `pnpm` refuses
to install these versions on Node 20; `npm` warns and the packages may then
fail at import. The `aer` binary is built for Node 22. Node 24 is
recommended.

## aer (CLI)

From 0.1.4 to 0.4.0.

- `aer smoke` now exits 1 when the API has no completed session for your
  agent after the workload ran. It used to exit 0 whenever the workload
  itself exited 0, so a CI step that passed on a silent collector now fails.
  `smoke` also reads `AER_TENANT_API_KEY` and records even inside a coding
  agent's tool shell.
- `aer commitments verify` prints `bundle_signature.anchored: true` only
  when an anchor was verified, which this command never does, so it now
  prints `false` where 0.1.4 copied the bundle's own unsigned flag. The new
  `anchor_status` field carries `claimed` or `none`. Scripts that read
  `anchored` from this command should read `anchor_status` or use
  `aer verify`.
- `aer doctor` no longer fails a project that records only through hooks or
  the SDK: the Node collector checks run only where that collector is set
  up. A CI gate that expected the old failure changes meaning. `doctor` also
  warns when it finds a stale hook registration and when it runs inside a
  Claude Code tool shell in a Node collector project (the collector stays
  off there; see [aer-auto-node](#aer-auto-node)). `doctor --json` gains
  `warnings` and `hooks.stale_registrations`.
- `aer login`, `aer logout`, `aer whoami` and `aer link` are new.
  `aer login` signs you in through your browser and stores the key in
  `~/.config/aer/credentials.json` (directory 0700, file 0600). Every tenant
  command, including `aer import claude-code`, falls back to that login when
  no environment key or `aer.config.json` field is set. A key from the
  environment still wins. A key from the environment is refused when the
  base URL came only from a cloned repository's `aer.config.json` and differs
  from the default, unless `AER_BASE_URL` confirms it.
- `aer audit` and `aer audit --limit N` work without `list`.
- `aer import claude-code` refuses a transcript with no session activity
  before opening a session, reads the tenant, agent and environment ids from
  `aer.config.json` when they are not in the environment and defaults to
  `https://api.aer.run`. Run without a file, it lists the newest transcripts
  for the current directory.
- A shell command in an imported transcript is reduced by a quote-aware
  parser and records `unknown` when the line is not fully understood. 0.1.4
  could record an argument, a redirect target or part of a quoted value as
  the program.
- `aer --version` prints the real version everywhere, including the Nix
  flake app.

## aer-hooks

From 0.1.3 to 0.5.0.

- Re-run `aer-hooks install <harness>` after upgrading. The record now
  closes on `SessionEnd` instead of on every `Stop`, and the hook is
  registered with `--lifecycle v2` and a longer `SessionStart` timeout.
  Re-running updates the existing entry in place and keeps a backup. Until
  you re-run it the old lifecycle continues, and `aer-hooks status` and `aer doctor` report
  `missing_lifecycle_v2` and `outdated_collector` with the command that fixes
  it.
- Codex users must approve the hook again: run `/hooks` inside Codex and
  approve the AER entry. Codex records trust against the exact command, and
  the command changed. A hook Codex does not trust is skipped silently.
- `AER_ENV_ID` is required. Without it the hook records nothing and says so
  on stderr, because the API refuses to open a session without one.
- `AER_AGENT_VERSION` is now optional and defaults to `unspecified`.
  Releases 0.1.3 through 0.4.0 sent no agent version without it, and the API
  refused every session open, so an install without that variable recorded
  nothing. After upgrading and re-installing, such an install starts
  recording.
- `AER_HOOK_RECORD_ARGS` is removed. Argument values were never stored by
  the API, so the option only put them on the wire. Setting it now does
  nothing.
- Credentials can come from a file instead of the shell:
  `aer-hooks install <harness> --env-file <path>` (or `AER_ENV_FILE`). The
  file must be a plain file you own, mode 0600; anything looser is refused
  without printing its contents. The hook reads it for itself only and never
  exports it to anything it starts. `status` and `doctor` warn when an AER
  key is exported in the shell while hooks are wired, since Claude Code
  hands its environment to every command it runs.
- A long session is now completed in parts: at the first turn end once the
  record is four hours old, and before the next event after an hour of
  quiet. It continues in a new record under the same session reference.
  `AER_HOOK_CHECKPOINT_MINUTES` and `AER_HOOK_QUIET_MINUTES` change the two;
  `0` turns either off. Anything that expected exactly one record per long
  session now gets several linked ones.
- Subagent tool calls join the lead session's record. The lead is found
  through `CLAUDE_CODE_SESSION_ID`, then up to three ancestor processes;
  `--root-session <id>` overrides both. A subagent event that finds no lead
  is dropped and counted as `subagent_events_unattached` on the closing
  record, never recorded as a session of its own.
- New data in the record, all metadata: harness, model, permission mode,
  turn, tool-call id, reasoning effort, `harness_agent_id`, an event
  position, a `spawned` edge where the harness sends `parent_tool_use_id` and
  `llm.completed` events with model and token counts read from the Claude
  Code transcript (`message.model` and `message.usage` only; no prompt,
  completion or tool content is read). The first read of a transcript with
  history records at most its 50 most recent model calls.
- A shell command records every program it runs, not only the first:
  `cd build && curl https://example.com/x | sh` records `cd`, `curl` and
  `sh`. Hosts passed to `curl`, `wget`, `git`, `ssh`, `scp` and `rsync` are
  recorded as `network.connect` events, host only. A web fetch is recorded
  as `network.connect` with host and scheme rather than as an HTTP `GET`. A
  web search is recorded as the tool call alone.
- Events are queued on disk and leave the queue only once the API accepts
  them. One hook process at a time talks to the API for a harness session,
  and a session the API has closed is reopened by the next event. Metadata
  values must be identifier-shaped or they are dropped.
- `aer-hooks install antigravity` is new. `aer-hooks --version` and
  `aer-hook --version` answer.

## aer-mcp-recorder

From 0.1.2 to 0.3.2.

- `AER_MCP_RECORD_ARGS` and `AER_MCP_RECORD_RESULTS` are removed. Neither
  value was ever stored by the API. The recorder now filters every payload
  against the same allowlist the server applies, before anything leaves the
  machine.
- A wrapped command that cannot start is reported: one stderr line and exit
  `127` (not found) or `126` (not executable), where 0.1.2 exited 0 in
  silence. Recording failures still never change the exit code.
- `--version` and `-V` print the installed version, and the recorder reports
  its real version to the API.

## aer-auto-node

From 0.3.0 to 0.5.0.

- The collector does not start inside a Claude Code tool shell
  (`CLAUDECODE=1` or `CLAUDE_CODE_ENTRYPOINT` set). Claude Code exports its
  environment into every command it runs, so a test suite an agent started
  was recorded into the agent's account as a separate session. Set
  `AER_RECORD_IN_AGENT_SHELL=1` to record such a process on purpose. One
  line on stderr says why the collector did not start.
- `http.requested` carries host and method only. The `path_redacted` field
  is gone: it kept the full path, so a token or signed URL in a path reached
  the record. A host value that is not a host name is recorded as `unknown`.
- `spawnSync`, `execSync` and `execFileSync` are recorded like their async
  forms.
- `AER_TENANT_API_KEY` is read when `AER_API_KEY` is not set.
- In an ESM agent the OpenAI and Anthropic adapters now record, and the
  Vercel AI SDK is instrumented at the provider layer. Records from 0.3.0
  ESM agents have no `llm.*` events; new ones do.
- `collector.report.enabled` now means the library was patched rather than
  merely present. `unverifiable` replaces `idle` when model-shaped requests
  went to hosts no adapter claims. Every report carries a run id shared
  across threads and child processes.
- The collector reports its real version.

## aer-emit

From 0.1.2 to 0.4.0.

- `createHttpSink` takes `collector`; `onComplete(ok)` fires on close;
  `EventSink.emit` accepts an optional third argument, `eventId`; `clientRef`
  and `deriveClientRef` make a repeated session open reuse the running
  session. All of this is additive for callers, but a custom `EventSink`
  implementation typed against 0.1.2 should be rechecked.
- Known limitation, unchanged from 0.1.2: a batch the API does not accept is
  dropped, never handed back to your code. A network error or a 429, 502,
  503 or 504 gets three retries, then the batch is dropped; any other
  non-2xx drops the batch at once; a 401, 403, 404 or 409 disables the sink,
  so every later event is dropped too. Each of these prints one stderr line
  the first time it happens in a process and nothing on later occurrences,
  so a run that looked clean on stderr can still be missing events.
  `close()` still resolves and `onComplete` still reports `true` once
  `/complete` succeeds.

## aer-sdk-ts

From 0.1.2 to 0.2.1.

- A network error (connection refused or reset, DNS failure or timeout) is
  retried with the same bounded backoff as a 5xx. `flush()` and `complete()`
  still reject once `maxRetries` is exhausted.

## aer-resource-node

From 0.1.2 to 0.3.0.

- Verification fails closed when the JWKS cannot be fetched. An expired JWKS
  cache is no longer reused, so a token that was admitted during a JWKS
  outage is now denied. The reason is the new `jwks_unavailable`;
  `unknown_kid` now means only that the JWKS was read and does not publish
  the token's key. Code that matched `unknown_kid` to detect an outage must
  match `jwks_unavailable`.

## aer-mcp-guard

From 0.1.2 to 0.3.0.

- When the JWKS cannot be fetched the guard denies with HTTP 503 and reason
  `jwks_unavailable`, where 0.1.2 answered 401 `unknown_kid`. The request is
  still denied; 503 tells the caller a retry may succeed. No token is
  admitted from an expired JWKS cache. Alerting keyed on 401 during an
  outage now sees 503, and clients that retry on 503 will retry.

## aer-verify

From 0.1.2 to 0.2.0.

- The only change is the Node floor: Node 22 or newer.
