# Changelog

## 0.7.0

### Minor Changes

- [`4dabec4`](https://github.com/Ad-Astra-Computing/aer/commit/4dabec497b93185f1ee4f835d06daa4da66265f4) - aer-hooks now records two new event types, human.input and approval.decided, so a completed session's record can show how much a human was supervising it. Install or doctor again to pick up the two additional hook registrations this needs.

  aer-mcp-recorder's vendored ingest allowlist picked up the two new keys to stay in sync; it does not send them itself.

  A pre-release security review found that a lost PreToolUse hook invocation (a crash, timeout or killed process, never reaching the collector) could get its approval.decided wrongly paired onto an unrelated open tool call, recording "allowed, prompted" for a call nobody actually prompted on. The narrow single-open-call fallback that caused this has been removed; an unmatched approval request is now always counted unresolved instead of guessed at.

## 0.6.0

### Minor Changes

- [`95ac511`](https://github.com/Ad-Astra-Computing/aer/commit/95ac5112cc0674822fba81c0606a68934324e755) - The record of a session now completes when the harness allows the session's last
  hook only a short time. Configs written by `aer-hooks install` already gave
  Claude Code's SessionEnd a 15-second timeout and completed; what is fixed is a
  Claude Code entry without a `timeout` (a hand-written or edited config), which
  `claude -p` cancelled after 1.5 seconds, and Codex, which caps SessionEnd hooks
  at 3 seconds. Both left the session open until the server closed it hours later,
  without a summary.

  - The installer now writes `--end-budget-ms` on the entry that ends a session
    (Claude Code and Codex SessionEnd, Antigravity `Stop`). The hook delivers for
    that long itself, up to 30 seconds. Run `aer-hooks install` again to add
    it; `aer-hooks status` and `aer doctor` point out an entry without it. On
    Codex, re-running install changes the registered command, so Codex skips
    the hook silently until it is approved again.
  - The hook also starts a short-lived background process that outlives the
    harness and finishes what is left: all of it when no budget is declared, in
    which case the hook itself stops 1.2 seconds after it started. The process
    gets only the variables it needs, writes its notes to `drain.log` in the state
    directory and exits after about a minute at most. A container that ends with
    the harness ends it too, and on Windows none is started.
  - The closing report is no longer dropped after repeated failed sends, nor when
    the queue of unsent events is full, and its count of dropped events stays
    current. A failure where no answer came at all no longer counts toward the
    limit on failed sends.
  - A batch of events that runs out its full request time with no answer is sent
    in halves after that, so a queue that only large requests fail on still
    drains in a few requests.
- [`948d8f2`](https://github.com/Ad-Astra-Computing/aer/commit/948d8f29587619308bd46650b20bacc84f471da8) - The opencode plugin now reduces tool calls the way the shell hooks do: a
  `bash` call is recorded as the programs it runs and the hosts its network
  clients were pointed at, `read`, `write` and `edit` as the file path and
  `webfetch` as the target's host, never the command line, the content or the
  URL path. Its session is declared as the `aer-hooks` collector recording a
  harness, not as a wrapped process, and every event it sends, LLM usage
  included, carries `harness: opencode`. When opencode disposes its plugins,
  which is how `opencode run` ends, the record gets a `session_end` marker
  before it is completed, and dispose waits at most 3 seconds for the AER API
  so an API that never answers cannot hold opencode's exit.

### Patch Changes

- [`e57f213`](https://github.com/Ad-Astra-Computing/aer/commit/e57f213a4bec97891042e75fbc5e55f702bc9b88) - Antigravity tool calls are now recorded. `aer-hooks install antigravity` wrote
  the tool events in the flat form Antigravity uses for its invocation events,
  and Antigravity loads that form for a tool event without complaint but never
  runs it, so a run recorded its turns and none of its tool calls. The tool
  events are now written as a matcher group, the form Antigravity fires them
  from; run `aer-hooks install antigravity` again to update an existing
  registration. Until it is, `aer-hooks status` and `aer doctor` report such a
  registration as recording no tool calls and name that command. The hook also
  reads the argument names Antigravity actually sends (`CommandLine`,
  `AbsolutePath`, `TargetFile`, `Url`), so a shell line is reduced to its
  programs and hosts, and a file read or write records its path, as they
  already were for Claude Code and Codex.
- [`e57f213`](https://github.com/Ad-Astra-Computing/aer/commit/e57f213a4bec97891042e75fbc5e55f702bc9b88) - `aer-hooks install codex` now honours `CODEX_HOME`. Codex reads its
  configuration from `$CODEX_HOME` when that is set, but the installer always
  wrote `~/.codex/hooks.json`, so on such a machine the install looked finished,
  `aer-hooks status` reported the hooks wired and Codex never ran them. The
  installer, `status` and `uninstall` now use `$CODEX_HOME/hooks.json` when
  `CODEX_HOME` is an absolute path, including with `--dir` set to your home
  directory; an explicit `--dir` anywhere else is unaffected. A relative
  `CODEX_HOME`, which Codex resolves against whatever directory it starts in, is
  refused by `install` and reported by `status` and `aer doctor`; an empty one
  counts as unset. Where AER hooks are still in `~/.codex/hooks.json` while
  `CODEX_HOME` points somewhere else, `install` and `status` say so and print
  the command that removes them. A `~/.codex` that is a link to `CODEX_HOME`,
  or the other way round, is recognised as the same directory.
- [`e57f213`](https://github.com/Ad-Astra-Computing/aer/commit/e57f213a4bec97891042e75fbc5e55f702bc9b88) - A file Codex writes is now recorded. Codex edits files through `apply_patch`,
  whose one argument is the whole patch, so the record showed the tool call and
  nothing about which file changed. The hook now reads only the patch's file
  headers, inside its `*** Begin Patch` and `*** End Patch` lines, and records a
  `file.written` event for each file added, updated, deleted or moved to,
  resolved against the session's working directory. A patch naming more than 16
  files records the first 16 and puts the number it named in `count` on its
  `tool.started` event, so the record says it is incomplete. The patch content
  is never read into the record.
- [`948d8f2`](https://github.com/Ad-Astra-Computing/aer/commit/948d8f29587619308bd46650b20bacc84f471da8) - The opencode plugin now records a tool name only when it is a string of at
  most 200 UTF-16 code units with no control characters. Any other name, such
  as an oversized MCP tool name, is recorded as `(unrecordable tool name)` and
  each such call adds a `collector.report` marker with phase
  `tool_name_replaced`, so the tool event is no longer refused by the AER API.

## 0.5.1

### Patch Changes

- [`2868e47`](https://github.com/Ad-Astra-Computing/aer/commit/2868e474f718c709f47cb43314012fe3621a9473) - The README now describes what the hooks actually capture: a shell
  command's programs and hosts, a file read or write's path, a web fetch's
  host and scheme and a Claude Code transcript's model, token counts and a
  few identifying fields, alongside the tool-name-and-argument-key rule that
  still covers everything else. It also documents that a refused
  `--env-file` falls back to the process environment with a warning rather
  than recording nothing, and fixes the env-file example to name all four
  required variables.
- Updated dependencies
  - @adastracomputing/aer-emit@0.4.1

## 0.5.0

### Minor Changes

- [`b545f3e`](https://github.com/Ad-Astra-Computing/aer/commit/b545f3e05608c01d306921ecfa09f2a4bb88adb6) - The hooks can now read their AER credentials from a file instead of the shell
  environment: `aer-hooks install <harness> --env-file <path>` writes the file
  into every hook command, and the hook reads its `AER_*` lines for its own use
  only, never exporting them to anything it starts. Keeping the key out of the
  shell profile stops it reaching every command the agent runs, where anything
  that loads an AER emitter would record under the harness agent. The file must
  be a plain file owned by you and readable by no one else; anything looser is
  refused with a message that never shows its contents, and the installer
  refuses it up front. `AER_ENV_FILE` works in place of the flag. `aer-hooks
  status` and `aer doctor` now warn when an AER key is exported in the shell
  while hooks are wired.
- [`b545f3e`](https://github.com/Ad-Astra-Computing/aer/commit/b545f3e05608c01d306921ecfa09f2a4bb88adb6) - A shell command now records every program it runs, not only the first. A line
  such as `cd build && curl https://example.com/install.sh | sh` used to record
  only `cd`; it now records `cd`, `curl` and `sh`, reading into pipelines,
  `&&`, `||`, `;`, subshells, command substitutions and wrappers like `sudo`,
  `env` and `xargs`. The hosts that `curl`, `wget`, `git`, `ssh`, `scp` and
  `rsync` are pointed at are recorded as `network.connect` events, host only:
  no user name, password, port, path or query is sent.

  A web fetch is now recorded as `network.connect` with the host and scheme,
  rather than as an HTTP request with a `GET` method the hook never actually
  observed. A web search is recorded as the tool call alone, since the search
  provider is not known to the hook and its query is never sent.
- [`b545f3e`](https://github.com/Ad-Astra-Computing/aer/commit/b545f3e05608c01d306921ecfa09f2a4bb88adb6) - The hook no longer loses events when the AER API is slow, fails or has closed
  the session.

  - Events are queued on disk and leave the queue only once the API has accepted
    them. A failed or timed out send, a failed session open (such as a 503) or a
    hook cut off by its time budget leaves them for the next event to send,
    instead of dropping them. Previously the model calls read from a transcript
    were marked as read before they were sent, so a failed send lost them for
    good.
  - Only one hook process at a time talks to the API for a harness session; the
    others queue their events and return immediately. Concurrent hooks from a
    lead agent and its subagents no longer wait on each other's network calls,
    drop subagent events, repeat event positions or open extra sessions.
  - When the API has closed the session (for example after a long idle period),
    the next event opens a new one and sends what was queued, instead of every
    later event being refused for the rest of the day.
  - A long interactive session that never sends its end event is now completed
    in parts: at the first turn end once the record is four hours old, and
    before the next event after an hour of quiet. It continues in a new record
    under the same session reference. `AER_HOOK_CHECKPOINT_MINUTES` and
    `AER_HOOK_QUIET_MINUTES` change the two; `0` turns either off.
  - Every lifecycle report now carries the registered events, the event count
    and the drop counters, not only the opening or closing one.
  - The first read of a transcript with existing history records at most its 50
    most recent model calls, sent in batches of at most 100 events.
  - If the cache dir cannot be written, state is kept in the runtime dir or a
    private per-user directory under the temp dir, so the hook still records one
    session rather than dropping tool events.

### Patch Changes

- [`b545f3e`](https://github.com/Ad-Astra-Computing/aer/commit/b545f3e05608c01d306921ecfa09f2a4bb88adb6) - The hooks and the opencode plugin now always send an agent version when they
  open a session, recording `unspecified` when `AER_AGENT_VERSION` is not set.
  The AER API requires one, so without that variable every session open was
  refused and nothing was recorded. `AER_ENV_ID` is likewise required by the
  API: without it the hook now records nothing and says why on stderr, rather
  than queuing events for a session that can never open, and the README lists
  it as required.
- [`2fba316`](https://github.com/Ad-Astra-Computing/aer/commit/2fba31694fe8fdbf23461f479cc71a50fa2843f4) - `aer doctor` and `aer-hooks status` no longer call an `aer-hook` binary
  "wired" when nothing actually points at it: they now say it was found "on
  PATH" instead, and reserve "wired" for a binary a harness config really
  references. An install too old to print its own version is reported as
  unreadable rather than as a specific version number nobody actually read off
  it, and the message still tells you to upgrade.

## 0.4.0

### Minor Changes

- [`958d73b`](https://github.com/Ad-Astra-Computing/aer/commit/958d73bf42c828d6d7067bd6851d962d2d632b24) - Subagent tool calls now join the lead's record instead of opening their
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
- [`65e71eb`](https://github.com/Ad-Astra-Computing/aer/commit/65e71eb53a1f013a5cbc5362f458c247cfc41ab2) - Claude Code hook sessions now carry model and token counts.
  `hook_event_name` payloads never include `model` or usage, so a
  hooks-recorded session had tool events and no `llm.completed` at all. On
  PostToolUse, Stop, SubagentStop and SessionEnd, the collector now reads the
  Claude Code transcript (`transcript_path`, present on every payload)
  incrementally from a persisted byte offset, extracts only `message.model`
  and `message.usage` from newly-appeared assistant entries, and emits
  `llm.completed`. Bodies-off throughout: no prompt, completion text or tool
  content is read or emitted, streamed duplicate entries for the same message
  are recorded once with their final usage, a missing or unreadable transcript
  is silent, and the read is bounded per invocation. The updated read offset
  and message-id dedup state are saved to the session store before the network
  send that follows, the same way the event sequence counter already is, so a
  slow or failed send never risks the next hook rescanning and double-reporting
  what this one already claimed.

### Patch Changes

- [`958d73b`](https://github.com/Ad-Astra-Computing/aer/commit/958d73bf42c828d6d7067bd6851d962d2d632b24) - The installed `aer-hooks` version is baked in at build time, so a bundled
  CLI reports it correctly. The session open is retried without `client_ref`
  only when the server's 400 names that field, and a late write from a stalled
  opener can no longer move the stored event position backwards.
- Updated dependencies
  - @adastracomputing/aer-emit@0.4.0

## 0.3.0

### Minor Changes

- [`5d8c488`](https://github.com/Ad-Astra-Computing/aer/commit/5d8c4884b029fdc66566df9fbd36217e57de1a89) - **Breaking:** the minimum supported Node is now 22, up from 20.

  Node 20 reached end of life on 30 April 2026 and receives no further security
  fixes, so these packages no longer claim to support it. Node 22 is supported
  until 30 April 2027 and remains the floor until then. Node 24 is the current
  long-term support release and is recommended.

  With pnpm, which enforces this field, installing on Node 20 now fails rather
  than warning. With npm it warns.

### Patch Changes

- Updated dependencies
  - @adastracomputing/aer-emit@0.3.0

## 0.2.2

### Patch Changes

- [`6c416e4`](https://github.com/Ad-Astra-Computing/aer/commit/6c416e4999a4f97d7ea62080b1518817f52f3516) - Answer `--version`

  Neither binary could say which version it was. That is the first question a
  support conversation asks when a record looks wrong, and the answer was
  unavailable from the machine that produced it. `aer --version`, `aer-hooks
  --version` and `aer-hook --version` now print the installed version and exit 0,
  and `-V` is accepted for both spellings people reach for.

  The version is read from the package manifest a release bumps, never restated
  in the source, so it cannot drift a release behind.

## 0.2.1

### Patch Changes

- [`2ef4004`](https://github.com/Ad-Astra-Computing/aer/commit/2ef40044dd7b78fbb0f0172f1371f844c1fbf637) - Record which tool call spawned a subagent

  A nested agent's steps had nothing tying them back to the call that started
  them, so a record could show that a subagent ran but not who sent it. Where a
  harness sends `parent_tool_use_id`, it is now recorded and signed into the
  bundle as a `spawned` edge, and the console draws the subagent as its own lane
  beside the main thread.

  Metadata only, in keeping with bodies-off: an identifier, never the call's
  arguments or its result. No harness documents this field today, so it is
  recorded only where one sends it.

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
