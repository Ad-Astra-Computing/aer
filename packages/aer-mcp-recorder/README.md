# @adastracomputing/aer-mcp-recorder

Record the MCP tool activity a coding harness drives, with no harness integration.

`aer-mcp-recorder` is a transparent MCP proxy. You drop it in front of your real
MCP server and point your harness at the proxy. The proxy forwards the byte
stream between the harness and the real server unchanged, parses a copy for recording and
emits AER events (`tool.started`, `tool.completed`, a coverage report). The harness
(Claude Code, Cursor, Cline, Codex, custom stacks) needs no AER code. If it speaks
MCP, its MCP tool calls are recorded.

This is the observation half. It is separate from
[`@adastracomputing/aer-mcp-guard`](https://www.npmjs.com/package/@adastracomputing/aer-mcp-guard),
which is the admission half (deny or allow). The recorder observes and emits, the
guard denies and allows, and the two can run side by side.

ESM only: use `import`, not `require`. Requires Node 20 or newer.

## Two properties this package is designed for

**Fail-open byte transparency.** The proxy forwards the raw byte streams unchanged
and records from a copy. If the recording path throws, is misconfigured or the AER
sink is unreachable, the proxy still forwards the stream unchanged and the child's behavior
and exit code are unaffected. Recording is strictly best-effort and never in the
critical path. Your tools never break because you wrapped them.

**Redaction by default.** By default the recorder captures tool names, argument key
names (not values), the result error flag and result size, plus timing. It never
captures argument values or result content unless you explicitly opt in.

## Install

```
npm i -g @adastracomputing/aer-mcp-recorder
```

## Claude Code config

Wrap your real MCP server command. In your MCP config, replace the server's
`command` with `aer-mcp-recorder` and pass the real command after `--`:

```json
{
  "mcpServers": {
    "my-tools": {
      "command": "aer-mcp-recorder",
      "args": ["--", "your-mcp-server", "--flag"]
    }
  }
}
```

That is the whole change. The harness talks to the recorder, the recorder talks to
`your-mcp-server` and AER sees the tool calls.

## Configuration

All configuration is by environment variable. Without `AER_API_KEY`,
`AER_TENANT_ID` and `AER_AGENT_ID` the proxy records nothing and simply forwards
bytes.

| Variable | Purpose |
| --- | --- |
| `AER_API_KEY` | Tenant API key. Required to record. |
| `AER_TENANT_ID` | Tenant id. Required to record. |
| `AER_AGENT_ID` | Agent id. Required to record. |
| `AER_ENV_ID` | Environment id. Optional. |
| `AER_AGENT_VERSION` | Agent version string. Defaults to `mcp-recorder/<package version>` when unset, since the API requires an agent version on every session. |
| `AER_BASE_URL` | API base URL. Default `https://api.aer.run`. |
| `AER_PRINCIPAL_ID` | Human, service or CI identity the run is on behalf of. Optional. |
| `AER_PRINCIPAL_KIND` | `user`, `service` or `ci`. Optional. |
| `AER_PRINCIPAL_DISPLAY` | Short label for feeds. Optional. |
| `AER_MCP_RECORD_ARGS` | Set to `1` to also capture argument values. Off by default. |
| `AER_MCP_RECORD_RESULTS` | Set to `1` to also capture result content. Off by default. |
| `AER_CLOSE_TIMEOUT_MS` | Shutdown flush budget in milliseconds. Default `15000`. Must be a positive integer; an invalid value is ignored (with a stderr warning) and the default is used. |

## What it records

By default each MCP tool call produces two events. The default `tool.started`
payload is:

```json
{ "tool": "search", "arg_keys": ["query", "limit"] }
```

and the default `tool.completed` payload is:

```json
{ "tool": "search", "ok": true, "is_error": false, "duration_ms": 42, "result_size": 318 }
```

No argument values and no result content appear unless you opt in with
`AER_MCP_RECORD_ARGS=1` or `AER_MCP_RECORD_RESULTS=1`. On close the recorder emits a
`mcp.recorder.report` coverage event carrying the recorder version, the server name
and version, the tools it saw, plus call and error counts.

## Shutdown and exit codes

The wrapped server's own exit code always wins: if it exits non-zero, or dies to a
signal, the proxy reports that outcome unchanged (a signal death is reported as
`128 + signal number`, matching shell convention, never as a clean `0`). Only when
the wrapped server exits cleanly does the recorder's own shutdown matter: on a clean
exit, the proxy waits up to `AER_CLOSE_TIMEOUT_MS` (default 15000ms) for the
recorder to flush its last events and close the AER session. If that budget is
exceeded, the proxy exits `70` and writes one line to stderr noting the record may
be incomplete, rather than reporting a silent success.

## Caveat

This records only MCP-mediated activity. It does not see harness-native file edits,
shell commands or model calls that do not go through this MCP server. It is one
capture surface among several. AER records activity visible through configured
integration surfaces, not everything an agent does.

## Composition with the guard

The recorder and the guard sit in the same position in front of an MCP server.
They are separate packages you can run independently: the recorder observes and
emits, the guard admits and denies.

## License

Apache-2.0
