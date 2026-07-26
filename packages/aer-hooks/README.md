# @adastracomputing/aer-hooks

Record what a coding harness does, using the harness's own hooks. Claude Code and
OpenAI Codex CLI both fire shell hooks that pass a JSON event on stdin
(SessionStart, PreToolUse, PostToolUse, Stop, UserPromptSubmit). One binary
normalizes both harnesses' payloads and emits the tool events into AER.

## Install

```
npx @adastracomputing/aer-hooks install claude-code
npx @adastracomputing/aer-hooks install codex
```

That wires `aer-hook --harness <name>` into the harness config for PreToolUse,
PostToolUse, SessionStart and Stop. Check what is wired with:

```
npx @adastracomputing/aer-hooks status
```

Remove AER's entries (and only AER's) with:

```
npx @adastracomputing/aer-hooks uninstall claude-code
```

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

## Redaction by default

The hook records tool names, argument KEY names (the `Object.keys` of the tool
input) and result flags only. It never records argument values or result content.
Set `AER_HOOK_RECORD_ARGS=1` to opt in to recording argument values.

## Fail-open, never blocking

The `aer-hook` binary is designed so it can never break or slow the harness. It
wraps everything in try/catch, caps its own runtime with a hard timeout after which
it exits 0 regardless and never writes to stdout (some harnesses interpret hook
stdout). If AER is unconfigured it does nothing and exits 0. Recording is always
best-effort and never in the critical path of the tool the harness is running.

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
and argument KEY names only, never values, unless `AER_HOOK_RECORD_ARGS=1`. If emit
is unconfigured the plugin is a total no-op.

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
