# @adastracomputing/aer-hooks

Record what a coding harness does, using the harness's own hooks. Claude Code and
OpenAI Codex CLI both fire shell hooks that pass a JSON event on stdin
(SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd and
the subagent boundaries). One binary normalizes both harnesses' payloads,
along with Antigravity's, and emits the tool events into AER.

ESM only: use `import`, not `require`. Requires Node 22 or newer.

## Install

The harness will run `aer-hook` on every event, so `aer-hook` has to be on
the harness's `PATH` for as long as you want recording. Put it there first:

```
npm install -g @adastracomputing/aer-hooks          # npm
nix profile add github:Ad-Astra-Computing/aer#tools  # Nix, also installs the aer CLI
```

Then wire it into the harness:

```
aer-hooks install claude-code
aer-hooks install codex
```

That writes `aer-hook --harness <name> --lifecycle v2` into the harness config
for the whole run lifecycle: SessionStart, UserPromptSubmit, PreToolUse,
PostToolUse, Stop, SubagentStart, SubagentStop and SessionEnd. `Stop` fires
once per assistant turn, so the record is completed at `SessionEnd` and a
multi-turn conversation stays one record. On Claude Code the SessionEnd entry
carries its own `timeout`, because that harness shares 1.5 seconds across
every SessionEnd hook and completing a record takes longer than that. If `aer-hook` is not on `PATH` at install
time, the installer writes the absolute path of the copy it is running from and
says so, which keeps recording working but ties the config to that install
location. `npx @adastracomputing/aer-hooks install ...` works the same way, and
is the case that needs the absolute path, since `npx` puts nothing on `PATH`.

That command is idempotent: running it again after an upgrade updates the
existing registration in place, rather than leaving it on an older hook
lifecycle. `npx @adastracomputing/aer doctor` (from the `aer` CLI) also
watches for a registration that has fallen behind, whether that is a missing
`--lifecycle v2`, an `aer-hook` on `PATH` older than the `aer-hooks` release
the CLI carries or a nix-profile copy of `aer-hook` shadowing the project's
own, and prints the exact re-run that fixes each one.

Moving from an earlier release? See [Upgrading](https://github.com/Ad-Astra-Computing/aer/blob/main/docs/upgrading.md#aer-hooks).

Check what is wired, and whether each wired command still resolves, with:

```
npx @adastracomputing/aer-hooks status
```

Remove AER's entries (and only AER's) with:

```
npx @adastracomputing/aer-hooks uninstall claude-code
```

### Codex will not run the hook until you trust it

Codex skips any hook it has not been told to trust, and skips it silently, so
a Codex install that looks finished records nothing. After installing, run
`/hooks` inside Codex and approve the AER entry. Trust is recorded against the
command itself, so upgrading AER can change the command and need approving
again. A project-local `.codex` layer also has to be a trusted project before
its hooks load at all.

### Keep the key out of the agent's shell

The hook needs `AER_API_KEY`, `AER_TENANT_ID`, `AER_AGENT_ID` and `AER_ENV_ID`, and
optionally `AER_BASE_URL`, `AER_AGENT_VERSION` and `AER_PRINCIPAL_ID`. With a key,
tenant or agent missing, the hook does nothing; with `AER_ENV_ID` missing it also
does nothing and says so on stderr, since the API refuses to open a session without
one. A harness does not tell its hooks its own version, so without
`AER_AGENT_VERSION` the session's agent version is recorded as `unspecified`.

Do not export them in your shell profile. A harness passes its environment to every
command its agent runs, so an exported key reaches all of them, and anything among
them that loads an AER emitter (an instrumented app, a test, `aer smoke`) records
under the agent the hooks record under. Put them in a file only you can read and
point the hooks at it instead:

```
install -m 600 /dev/null ~/.config/aer/hooks.env
$EDITOR ~/.config/aer/hooks.env      # AER_API_KEY=..., AER_TENANT_ID=..., AER_AGENT_ID=..., AER_ENV_ID=...
aer-hooks install claude-code --env-file ~/.config/aer/hooks.env
```

Every command the installer writes then carries `--env-file <path>`. The hook reads
only the file's `AER_*` lines and never puts the values into its own environment,
so nothing it starts inherits them. It refuses a file that is a link,
belongs to another user or can be read or written by anyone else, and says so on
stderr without showing the contents. Refused at hook run time rather than install
time (the file changed, or the flag was added by hand), the hook warns on stderr
and falls back to the process's own environment rather than recording nothing, so
a reader should not assume a refusal means silence. Installing again without
`--env-file` keeps the file already configured. `AER_ENV_FILE=<path>` works in
place of the flag. `aer-hooks status` and `aer doctor` warn when an AER key is
exported in the shell they run in while hooks are wired.

## One AER session per harness session

The harness runs the hook once per event as a separate process. To record a whole
harness session as one AER session instead of one session per tool call, the first
event opens an AER session and the later events join it. What the hook needs to
carry between events (the open session, the next event position, how far the
transcript has been read and which events the server has not yet accepted) is kept
in a small file under your cache dir (`$XDG_CACHE_HOME/aer-hooks` or
`~/.cache/aer-hooks`). That file holds a short-lived ingest token, so it is written
owner-only (0600) in an owner-only directory, and the token is removed when the
record completes. State untouched for a day expires.

If the cache dir cannot be written, the hook uses `$XDG_RUNTIME_DIR/aer-hooks`, then
a per-user `aer-hooks-<uid>` directory under the temp dir, refusing any directory it
does not own or that is a link. If none of them can be written, each event is still
recorded, sent on its own and joined to the running record by the server; the server
accepts a limited number of such joins per record (16), so a long session without
anywhere to keep state loses the events past that.

Events are queued on disk first and leave the queue only once the server has
accepted them. If the API is slow, fails or is unreachable, nothing is lost: the
events stay queued (up to 1000; past that the oldest are dropped and the count is
reported on the record) and the next hook event sends them. Only one hook process at
a time talks to the server for a harness session; the others queue their events and
return at once, so concurrent hooks from a lead agent and its subagents never wait
on each other's network calls or open a second session. If the server has closed the
session (for example after a long idle period), the next event opens a new one and
sends what was queued to it.

### Long sessions are recorded in parts

An interactive session can stay open for days and may never send its end event. So
that it is still sealed and summarised, the hook completes the record at the first
turn end once the record is four hours old, and before the next event when the
harness has been quiet for an hour. The session carries on in a new record under the
same session reference, with event positions continuing from the last one, so the
parts can be read back as one run. `AER_HOOK_CHECKPOINT_MINUTES` sets the age and
`AER_HOOK_QUIET_MINUTES` the quiet period; `0` turns either off. With both off, a
session that never sends its end is left for the server to close after it goes
quiet, without the summary a completed record gets. Whatever the settings, a record
is also completed at a turn end once it holds 20,000 events, well under the most the
server accepts in one session.

The first time the hook meets a transcript that already has history (it was
installed partway through a session), it records at most the 50 most recent model
calls from it rather than replaying the whole history.

On Claude Code, a subagent's tool calls join its lead session's record rather
than opening one of their own: the hook reads the lead's session id out of
its own environment, and falls back to checking a short chain of parent
processes when a harness version does not expose it. `--root-session <id>`
overrides both, for a caller that already knows which session a subagent
belongs to. A subagent event that still cannot find its lead is dropped
rather than starting a session of its own, and the drop is counted on the
closing record so a run that lost events is visibly incomplete rather than
silently split across two records.

## Redaction, with no way to turn it off

The hook records tool names, argument KEY names (the `Object.keys` of the tool
input) and result flags for most tools, never argument values or result
content, and there is no flag that changes that. A few tools carry a narrow,
named exception instead of the bare key-name rule: a shell command is reduced
to the programs it runs (up to 16) and the hosts its network clients were
pointed at (up to 8), never the command line itself; a file read or write
records the path, never the file's content; a web fetch records the target's
host and scheme, never its path or query; and a Claude Code transcript's
assistant messages contribute `llm.completed` events carrying the model name
and the input/output token counts, read from the transcript's `message.model`
and `message.usage` fields plus the entry's id, timestamp and subagent type,
never the prompt or completion text. Every payload, whatever tool produced it, is filtered against the set
of keys AER ingest stores before it is sent, so a value the record could not
hold never reaches the wire either.

If you need evidence about the arguments themselves, use content commitments
(ADR-011): the record carries a one-way tag you can later open against your own
retained plaintext with a key that never leaves your machine.

## Fail-open, never blocking

The `aer-hook` binary is designed so it can never break or slow the harness. It
wraps everything in try/catch, caps its own runtime with a hard timeout (default
10000ms, override with `AER_HOOK_TIMEOUT_MS`) after which it exits 0 regardless
and never writes to stdout (some harnesses interpret hook stdout). It stops
starting network calls shortly before the budget runs out, so what it could not
send stays queued for the next event rather than being cut off mid-request; if
the budget is exceeded anyway, it writes one stderr line saying so. If AER is
unconfigured it does nothing and exits 0. Recording is always best-effort
and never in the critical path of the tool the harness is running.

## Install safety

The installer is conservative. It reads, modifies and writes your config in place,
backs the existing file up to `<file>.bak` first, and if the existing JSON is
malformed it aborts rather than overwrite. Re-running is idempotent: it adds no
duplicate entries, and it only ever adds or removes AER's own hook entries.

## opencode (native plugin)

opencode loads in-process JS/TS plugins rather than firing shell hooks, so it gets
a native adapter here. Native plugin capture beats MCP-only: it also sees the
bash/read/write/edit tools that never cross an MCP proxy.

Add a tiny plugin file, `.opencode/plugins/aer.ts`:

```ts
import { aerOpencodePlugin } from '@adastracomputing/aer-hooks';
export const AerPlugin = aerOpencodePlugin;
```

The import resolves from the project's own `node_modules`, so install
`@adastracomputing/aer-hooks` in the project. Then set the same env the shell
hooks use (`AER_BASE_URL`, `AER_API_KEY` or `AER_TENANT_API_KEY`,
`AER_TENANT_ID`, `AER_AGENT_ID`, `AER_ENV_ID`, all required but the base URL).

One AER session is opened per opencode session, declared as the `aer-hooks`
collector recording a harness, with every event marked `harness: opencode`. It
is completed on `session.deleted` or when opencode disposes its plugins, which
is how `opencode run` ends; dispose writes a `session_end` marker first and
waits at most 3 seconds for the AER API, so an API that never answers cannot
hold opencode's exit.

Tool calls are reduced the way the shell hooks reduce them: tool names and
argument KEY names, never values, with the same narrow exceptions. A `bash` call
is reduced to the programs it runs and the hosts its network clients were
pointed at, a `read`, `write` or `edit` records the file path and a `webfetch`
the target's host. If emit is unconfigured the plugin is a total no-op.

The plugin sends events straight from opencode's process as they happen. It
does not have the shell hooks' on-disk queue and retry, so events it cannot
deliver while the API is unreachable are lost rather than sent later. It also
does not open idempotently with `client_ref`, number events with `seq`, write
checkpoint or `events_registered` evidence, or attach subagent sessions to their
lead.

Beyond tools, the opencode plugin also records LLM usage. Each assistant
`message.updated` carries the model, provider and token counts, so the plugin emits
`llm.requested` on first sighting of a message and `llm.completed` when it settles
(deduped by message id across the streaming updates). This is bodies-off: only the
model name, provider and input/output token COUNTS are read, never the prompt or
completion text (that content lives in separate `message.part.updated` events the
plugin never reads). These feed the AER token and cost summary the same way the
OpenAI/Anthropic auto-node adapters do.

For lower-level control, `createAerOpencodeHooks({ base })` returns the raw hooks
object.

## Other harnesses

Cline and other MCP-native harnesses are covered by
`@adastracomputing/aer-mcp-recorder` (a transparent MCP proxy). Use that where the
harness speaks MCP; use these hooks where the harness fires shell hooks or (opencode)
loads plugins.

## Limits of enforcement

Hooks capture the tool events the harness chooses to fire, and a user can disable
them. This is a recording aid, not a security boundary. For a boundary that does not
depend on the harness cooperating, record through the MCP proxy or the AER
attestation path.

## License

Apache-2.0
