# @adastracomputing/aer-hooks

Record what a coding harness does, using the harness's own hooks. Claude Code and
OpenAI Codex CLI both fire shell hooks that pass a JSON event on stdin
(SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd and
the subagent boundaries). One binary normalizes both harnesses' payloads,
along with Antigravity's, and emits the tool events into AER.

ESM only: use `import`, not `require`. Requires Node 22 or newer.

## Install

Every package here is pre-1.0, so install the `next` dist-tag until this
README says otherwise. The harness will run `aer-hook` on every event, so
`aer-hook` has to be on the harness's `PATH` for as long as you want
recording. Put it there first:

```
npm install -g @adastracomputing/aer-hooks@next     # npm
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
location. `npx @adastracomputing/aer-hooks@next install ...` works the same way, and
is the case that needs the absolute path, since `npx` puts nothing on `PATH`.

That command is idempotent: running it again after an upgrade updates the
existing registration in place, rather than leaving it on an older hook
lifecycle. `npx @adastracomputing/aer@next doctor` (from the `aer` CLI) also
watches for a registration that has fallen behind, whether that is a missing
`--lifecycle v2`, an installed `aer-hooks` older than what is on `PATH` now
or a nix-profile copy of `aer-hook` shadowing the project's own, and prints
the exact re-run that fixes each one.

Check what is wired, and whether each wired command still resolves, with:

```
npx @adastracomputing/aer-hooks@next status
```

Remove AER's entries (and only AER's) with:

```
npx @adastracomputing/aer-hooks@next uninstall claude-code
```

### Codex will not run the hook until you trust it

Codex skips any hook it has not been told to trust, and skips it silently, so
a Codex install that looks finished records nothing. After installing, run
`/hooks` inside Codex and approve the AER entry. Trust is recorded against the
command itself, so upgrading AER can change the command and need approving
again. A project-local `.codex` layer also has to be a trusted project before
its hooks load at all.

Configure AER with the standard environment: `AER_API_KEY`, `AER_TENANT_ID`,
`AER_AGENT_ID` (and optionally `AER_ENV_ID`, `AER_BASE_URL`, `AER_AGENT_VERSION`,
`AER_PRINCIPAL_ID`). With any of the three required values missing, the hook does
nothing.

## One AER session per harness session

The harness runs the hook once per event as a separate process. To record a whole
harness session as one AER session instead of one session per tool call, the first
event opens an AER session and the later events attach to it. The mapping from the
harness session id to the open session is kept in a small file under your cache dir
(`$XDG_CACHE_HOME/aer-hooks` or `~/.cache/aer-hooks`). That file holds a short-lived
ingest token, so it is written owner-only (0600) and removed when the harness
session ends. Stale entries expire after a day. If the cache cannot be written the
hook still records, it just falls back to a session per event.

Two hook processes can fire for the same harness session close together (a fast
tool sequence, parallel subagents). A short-lived lock file next to the store
makes the "is there already a session" check and the "open one and save it" write
atomic across processes, so concurrent hooks converge on one AER session instead
of racing to open two.

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
input) and result flags only. It never records argument values or result content,
and there is no flag that changes that. Every payload is filtered against the set
of keys AER ingest stores before it is sent, so a value the record could not hold
never reaches the wire either.

If you need evidence about the arguments themselves, use content commitments
(ADR-011): the record carries a one-way tag you can later open against your own
retained plaintext with a key that never leaves your machine.

## Fail-open, never blocking

The `aer-hook` binary is designed so it can never break or slow the harness. It
wraps everything in try/catch, caps its own runtime with a hard timeout (default
10000ms, override with `AER_HOOK_TIMEOUT_MS`) after which it exits 0 regardless
and never writes to stdout (some harnesses interpret hook stdout). If the budget
is exceeded, it writes one stderr line noting the record may be incomplete. If
AER is unconfigured it does nothing and exits 0. Recording is always best-effort
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

Then set the same env the shell hooks use (`AER_BASE_URL`, `AER_API_KEY` or
`AER_TENANT_API_KEY`, `AER_TENANT_ID`, `AER_AGENT_ID`, `AER_ENV_ID`). One AER
session is opened per opencode session and completed on `session.deleted` or plugin
dispose. Redaction and fail-open are identical to the shell-hook path: tool names
and argument KEY names only, never values. If emit is unconfigured the plugin is a
total no-op.

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
