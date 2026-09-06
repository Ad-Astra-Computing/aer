# Instructions for coding agents

This file is for an AI coding agent asked to add AER to a project. It is the
authoritative integration path. Prefer it over guessing from the READMEs.

AER records what an agent run actually did and seals it into a signed record
that anyone can verify. Adding it to a Node project should take one command and
should not require editing application code.

## Integrating AER into a Node project

Run this from the project root:

```sh
npx @adastracomputing/aer init --yes --json
```

It detects the package manager, the entrypoints and any known agent SDKs, then
writes:

- `aer.integration.json`, a machine-readable manifest of what it did
- `.env.example`, with the variables that must be set
- `NODE_OPTIONS="--import @adastracomputing/aer-auto-node/register"` wired into
  the run scripts

Read `aer.integration.json` rather than re-deriving state. Its `schema` field is
`aer.integration.v1` and it carries `entrypoints`, `instrumentation`,
`env_required`, `files_changed` and `verify_command`.

To see the plan without touching the project, use `--dry-run --json`. Do that
first if you are proposing a change for a human to approve.

## Confirming it worked

```sh
npx @adastracomputing/aer doctor --json
```

`doctor` checks configuration, that the API is reachable and that the credential
authenticates. It exits non-zero when something is wrong, so it is safe to gate
on. Do not report success without running it.

To prove the whole path end to end, including that a record is produced:

```sh
npx @adastracomputing/aer smoke
```

## What you need from the human

An AER account, from [aer.run](https://aer.run). The only required variable is
`AER_API_KEY`. Never write a key into a tracked file, a commit or a log line.
Put it in the environment and leave `.env.example` holding placeholders.

If no account exists yet, still run `init --dry-run --json` and show what the
integration would do. That is useful without credentials.

## What you can do with no account at all

Verifying a record needs nothing from us. `@adastracomputing/aer-verify` makes
no network calls, so given a bundle it recomputes the hash, checks the Ed25519
signature and evaluates the transparency-log evidence locally.

## Choosing a package

Reach for the smallest thing that fits:

- Instrumenting a Node agent with no code changes: `aer-auto-node`, via
  `aer init` above.
- Emitting events explicitly from your own code: `aer-sdk-ts`, or `aer_sdk` for
  Python (see `packages/sdk-py`, installed from this repository).
- Recording MCP tool activity without touching the harness:
  `aer-mcp-recorder`.
- Recording a coding harness such as Claude Code, Codex CLI or opencode:
  `aer-hooks`.
- Only letting attested agents reach your MCP server: `aer-mcp-guard`.
- Checking AER attestation tokens at your own API: `aer-resource-node`.
- Verifying a signed record: `aer-verify`.

## Things to get right

Do not add manual emit calls alongside `aer-auto-node`. It records tool calls,
model calls and egress on its own, and hand-written events on top produce
duplicates.

Do not put prompts, tool arguments, tool results or file contents into events.
AER is deliberately bodies-off: it records names, hosts, counts and timings, not
payloads. The server strips unknown payload keys at ingest, so anything extra is
dropped rather than stored.

Do not pin a package to an exact version in a consuming project unless asked.
These packages move together and the ranges are chosen to match.
