# @adastracomputing/aer

Command line for AER (binary `aer`): wire auto-instrumentation into a Node
project, ingest and import agent runs and independently verify signed execution
records.

## Set up auto-instrumentation: `aer init`

Point it at a Node project and it wires in the AER auto-collector
(`@adastracomputing/aer-auto-node`), with no manual `emit()`. Designed to be run
unattended by a coding agent.

```bash
npx @adastracomputing/aer init                       # detect + write config, env, docs, manifest; wire NODE_OPTIONS
npx @adastracomputing/aer init --dry-run --json      # print the plan + integration manifest, write nothing
npx @adastracomputing/aer init --yes --tenant <id> --agent <id> --env <id>
npx @adastracomputing/aer doctor                     # check the integration is correct (exit 1 on problems)
npx @adastracomputing/aer smoke                      # run a tiny instrumented workload end to end
```

`init` detects the package manager, runnable scripts and installed LLM SDKs
(OpenAI / Anthropic → adapters); writes `aer.config.json` (non-secret identity),
`.env.example` (only `AER_API_KEY`, the single secret), `AER_INTEGRATION.md`,
an `AGENTS.md` section and `aer.integration.json` (`schema: aer.integration.v1`,
the machine-readable result a coding agent consumes); and prepends
`NODE_OPTIONS="--import @adastracomputing/aer-auto-node/register"` to the run scripts.
Flags: `--yes --dry-run --json --session <process|task|server> --entry <script>
--tenant/--agent/--env/--base-url`. An unrecognized `--session` value is a
usage error (exit 64), not a silent fallback to `process`.

`--help` (or `-h`) after any command prints usage and exits immediately,
before anything is written or any request is sent.

## Verify a record: `aer verify`

Downloads the canonical bundle and the public signing key, recomputes the hash
and checks the Ed25519 signature and transparency anchor locally.

```bash
AER_BASE_URL=https://api.aer.run npx @adastracomputing/aer verify <aer-id>
```

## Other commands

- `aer commitments verify --requests <file.json> (--aer <id> | --bundle <file.json>) [--key <public-key.json>]`:
  open content commitments by recomputing tags from your key and retained
  plaintext, then diffing them against the bundle. `--requests` and the tag
  recomputation never touch the network. Checking the bundle's own signature
  does need a public key: pass it locally with `--key <public-key.json>` (the
  object `GET /v1/keys/:key_id` returns), or set `AER_BASE_URL` to fetch it.
  `--bundle <file.json>` plus `--key` is fully offline; `--aer <id>` always
  fetches the bundle itself, so it always needs `AER_BASE_URL`. With neither a
  local key nor `AER_BASE_URL`, the command refuses to run rather than report
  an unverified match.
- `aer import claude-code <session.jsonl>`: turn a Claude Code transcript into
  bodies-off AER events on the client; names and hosts only, never content.
- `aer download <aer-id>`, `aer badge <aer-id>`: fetch the public bundle, print
  an embeddable badge.
- `aer agents | sessions | findings | aers | webhooks | audit`: tenant
  operations with `AER_TENANT_API_KEY` set.

Run `aer` with no arguments for the full usage text.

## `aer ingest`

Streams JSONL events to the batch-ingest endpoint. Useful for replaying
captured sessions, load tests and fixture-driven demos.

```bash
export AER_BASE_URL=https://api.aer.run
export AER_SESSION_ID=<uuid>
export AER_INGEST_TOKEN=<bearer>

# One event per line, each a full Event (event_id, agent_session_id, …, payload)
aer ingest path/to/events.jsonl
```

Prints a JSON summary to stdout:

```json
{ "accepted": 742, "rejected": 0, "parseErrors": 0, "batches": 2 }
```

When the gateway rejects individual events, the summary carries a small
`errors` sample (index and first issue message, capped at 5 across the whole
run) and the same detail is printed to stderr:

```json
{
  "accepted": 0, "rejected": 2, "parseErrors": 0, "batches": 1,
  "errors": [
    { "index": 0, "message": "source_type: invalid enum value" },
    { "index": 1, "message": "agent_session_id: required" }
  ]
}
```

Behavior:

- Streams the file line by line, so it is safe on arbitrarily large fixtures.
- Lines failing `JSON.parse` are skipped and reported via `parseErrors`, not fatal.
- Batches are sized by `AER_BATCH_SIZE` (default 500). Respect the gateway's
  `MAX_EVENTS_PER_BATCH` (default 1000).
- Exits non-zero on any 4xx/5xx response from the gateway (these are unexpected;
  individual event validation errors are surfaced as `rejected` count on a 207
  response).

## Requirements

Node 20 or newer. The published binary is a single self-contained file with no
runtime dependencies.

## License

Apache-2.0
