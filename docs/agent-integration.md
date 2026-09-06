# Adding AER with a coding agent

This page is written for an AI coding agent asked to add AER to a project,
and for the person pointing one at it. It is the supported integration
path, so prefer it over inferring an approach from the package READMEs.

For agents changing this repository rather than consuming it, see
[AGENTS.md](../AGENTS.md).

## One command

From the root of a Node project:

```sh
npx @adastracomputing/aer init --yes --json
```

On Nix, run it from the flake instead of reaching for npx:

```sh
nix run github:Ad-Astra-Computing/aer -- init --yes --json
```

Same binary, same behavior. Everything below applies to either form, so
substitute `nix run github:Ad-Astra-Computing/aer --` wherever a command
says `npx @adastracomputing/aer`.

To run an instrumented agent with no npm at all, take the packages as a
node_modules tree and link it in. Every published package has zero external
runtime dependencies, so this tree is complete:

```sh
nix build github:Ad-Astra-Computing/aer#node-modules
ln -s ./result/lib/node_modules node_modules
node --import @adastracomputing/aer-auto-node/register agent.js
```

Link it rather than setting `NODE_PATH`, which Node ignores for ESM.

It detects the package manager, the entrypoints and any known agent SDKs,
then wires the collector into the run scripts and writes four files:

| File | What it is |
| --- | --- |
| `aer.config.json` | Non-secret identity: tenant, agent and environment |
| `.env.example` | The variables to set, with placeholders |
| `aer.integration.json` | Machine-readable record of what was changed |
| `AER_INTEGRATION.md` | The same thing for a human reader |

It also appends a short AER section to the project's `AGENTS.md`, creating
that file if it does not exist, so the next agent to work in the project
knows the collector is there. Existing content is preserved, and running
`init` again does not duplicate the section.

Instrumentation is applied by loading the collector before the program, so
no application code changes:

```json
"start": "NODE_OPTIONS=\"--import @adastracomputing/aer-auto-node/register\" node agent.js"
```

## Read the manifest, do not re-derive it

`aer.integration.json` is the source of truth for what the integration did:

```json
{
  "schema": "aer.integration.v1",
  "runtime": "node",
  "entrypoints": ["start"],
  "instrumentation": {
    "register": "@adastracomputing/aer-auto-node/register",
    "session_strategy": "process",
    "adapters": [],
    "transport": ["fetch", "http", "https", "child_process"]
  },
  "env_required": ["AER_API_KEY"],
  "files_changed": ["package.json", "aer.config.json", ".env.example",
                    "AER_INTEGRATION.md", "AGENTS.md"],
  "verify_command": "npx @adastracomputing/aer doctor"
}
```

To see the plan without touching anything, use `--dry-run --json`. It
prints the same manifest plus the file actions it would take. Do that
first when you are proposing a change for a human to approve.

## Confirm it, do not assume it

```sh
npx @adastracomputing/aer doctor --json
```

`doctor` exits non-zero when anything is wrong, so it is safe to gate on.
Each check reports separately, which tells you what to fix:

```json
{
  "checks": [
    { "name": "AER_BASE_URL", "ok": true, "detail": "https://api.aer.run" },
    { "name": "API reachable (/readyz)", "ok": true, "detail": "ready (200)" },
    { "name": "tenant auth", "ok": false,
      "detail": "no API key: export AER_API_KEY (or AER_TENANT_API_KEY)" }
  ]
}
```

Do not report the integration as working until `doctor` exits zero. To
prove the whole path, including that a signed record comes out the other
end:

```sh
npx @adastracomputing/aer smoke
```

## What you need from a person

An AER account, from [aer.run](https://aer.run). The only secret is
`AER_API_KEY`. Everything else is non-secret identity and belongs in
`aer.config.json`.

Never write a key into a tracked file, a commit or a log line. Leave
`.env.example` holding placeholders and set the real value in the
environment.

With no account yet, `init --dry-run --json` still works and still shows
what the integration would do.

## Choosing a package

Reach for the smallest thing that fits.

| You want to | Use |
| --- | --- |
| Instrument a Node agent with no code changes | `aer-auto-node`, through `aer init` |
| Emit events explicitly from your own code | `aer-sdk-ts`, or `aer_sdk` for Python |
| Record MCP tool activity without touching the harness | `aer-mcp-recorder` |
| Record a coding harness such as Claude Code or Codex CLI | `aer-hooks` |
| Let only attested agents reach your MCP server | `aer-mcp-guard` |
| Check AER attestation tokens at your own API | `aer-resource-node` |
| Verify a signed record | `aer-verify` |

## Mistakes to avoid

Do not add manual `emit()` calls alongside `aer-auto-node`. It records
tool calls, model calls and egress on its own, and hand-written events on
top produce duplicates.

Do not put prompts, tool arguments, tool results or file contents into
events. AER is deliberately bodies-off, and the server strips unknown
payload keys at ingest, so the data is dropped rather than stored. See
[bodies-off](./concepts/bodies-off.md).

Do not pin an exact version in a consuming project unless asked. These
packages move together and their ranges are chosen to match.
