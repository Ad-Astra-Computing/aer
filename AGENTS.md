# AGENTS.md

For an AI coding agent. Most of you are here because someone asked you to add
AER to their project, so that comes first. Working on this repository itself is
at the bottom.

AER records what an agent run actually did and seals it into a signed record
anyone can verify. Adding it to a Node project takes one command and should not
require editing application code.

## Adding AER to a project

Run this from the project root:

```sh
npx @adastracomputing/aer init --yes --json
```

On Nix, without npm:

```sh
nix run github:Ad-Astra-Computing/aer -- init --yes --json
```

It detects the package manager, the entrypoints and any known agent SDKs, wires
the collector into the run scripts and writes four files:

| File | What it is |
| --- | --- |
| `aer.config.json` | Non-secret identity: tenant, agent and environment |
| `.env.example` | The variables to set, with placeholders |
| `aer.integration.json` | Machine-readable record of what changed |
| `AER_INTEGRATION.md` | The same thing for a human reader |

It also appends a short AER section to the project's own `AGENTS.md`, creating
it if absent, so the next agent knows the collector is there. Existing content
is preserved and re-running does not duplicate it.

Instrumentation loads before the program, so no application code changes:

```json
"start": "NODE_OPTIONS=\"--import @adastracomputing/aer-auto-node/register\" node agent.js"
```

## Read the manifest, do not re-derive it

`aer.integration.json` is the source of truth for what the integration did:

```json
{
  "schema": "aer.integration.v1",
  "entrypoints": ["start"],
  "instrumentation": { "register": "@adastracomputing/aer-auto-node/register",
                       "session_strategy": "process" },
  "env_required": ["AER_API_KEY"],
  "verify_command": "npx @adastracomputing/aer doctor"
}
```

Use `--dry-run --json` to see the plan without touching anything. Do that first
when proposing a change for a human to approve.

## Confirm it, do not assume it

```sh
npx @adastracomputing/aer doctor --json
```

`doctor` exits non-zero when anything is wrong, so it is safe to gate on, and
each check reports separately. Do not report success until it exits zero. To
prove the whole path end to end, including that a record comes out:

```sh
npx @adastracomputing/aer smoke
```

## What you need from a person

An AER account, from [aer.run](https://aer.run). The only secret is
`AER_API_KEY`. Never write a key into a tracked file, a commit or a log line.

Verifying a record needs no account and no network:
`@adastracomputing/aer-verify` checks the hash, the signature and the
transparency-log evidence locally.

## Choosing a package

| You want to | Use |
| --- | --- |
| Instrument a Node agent with no code changes | `aer-auto-node`, through `aer init` |
| Emit events from your own code | `aer-sdk-ts`, or `aer_sdk` for Python |
| Record MCP tool activity without touching the harness | `aer-mcp-recorder` |
| Record Claude Code, Codex CLI or opencode | `aer-hooks` |
| Let only attested agents reach your MCP server | `aer-mcp-guard` |
| Check attestation tokens at your own API | `aer-resource-node` |
| Verify a signed record | `aer-verify` |

## Mistakes to avoid

Do not add manual `emit()` calls alongside `aer-auto-node`. It records tool
calls, model calls and egress on its own, and hand-written events duplicate.

Do not put prompts, tool arguments, tool results or file contents into events.
AER is bodies-off: the server strips unknown payload keys at ingest, so the data
is dropped rather than stored. See [bodies-off](./docs/concepts/bodies-off.md).

Do not pin an exact version unless asked. These packages move together.

## Working on this repository

Everything above is about using AER. This section is for changing it.

Nix is the toolchain. `nix develop` gives Node, pnpm, Python and pytest. Do not
install tools globally; add them to the flake devShell.

```sh
pnpm install --frozen-lockfile
pnpm -r build && pnpm -r typecheck && pnpm -r test
nix flake check --all-systems
```

Write the failing test first. Any change to a published package needs a
changeset (`pnpm changeset`), or it never ships.

These invariants hold everywhere and breaking one is a defect, not a tradeoff:

- **Bodies-off.** Never record prompts, model output, tool arguments, tool
  results or file contents. A command becomes its executable name, a URL its
  host.
- **The verifier stays dependency-free and offline.** Someone must be able to
  check a record without trusting or reaching us.
- **Fail closed.** Admission control and token verification deny when they
  cannot decide. An unreachable JWKS is a denial.
- **The Python SDK is stdlib-only** and is not published to PyPI.
- **ESM only, Node 20 or newer**, and every library ships its own types.

Treat all external input and model output as hostile until validated. No secret
enters the repository, a commit, a log line or a test fixture. Pin every
third-party action to a full commit SHA.

Commits: imperative subject, lowercase, under about 50 characters, no trailing
period, `feat(scope):` and `fix:` prefixes. A body only when the why is not
obvious. Sign every commit. Never name an AI agent in commit, branch or pull
request text. See [CONTRIBUTING.md](./CONTRIBUTING.md).
