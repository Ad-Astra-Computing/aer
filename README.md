<p align="center">
  <img src="docs/assets/aer-mark.svg" width="88" alt="AER">
</p>

<h1 align="center">AER client packages</h1>

<p align="center">
  A signed, tamper-evident record of what an AI agent actually did.
</p>

<p align="center">
  <a href="https://github.com/Ad-Astra-Computing/aer/actions/workflows/ci.yml"><img src="https://github.com/Ad-Astra-Computing/aer/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@adastracomputing/aer"><img src="https://img.shields.io/npm/v/@adastracomputing/aer?label=cli" alt="Latest CLI version on npm"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License Apache-2.0"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Requires Node 20 or newer">
</p>

---

AER (Agent Execution Record) gives every agent run a signed record of the tools
it called, the models it hit and the network egress it made. You can verify a
record offline, gate MCP servers on attested agents and hand an auditor a bundle
they can check without trusting you or us.

This repository holds the client side: the code you install into your own agents
and services. The service itself is a hosted product and is not open source.

## How this fits together

AER has two halves, and only one of them is here.

**The service is hosted and closed.** Ingest, signing, storage and the console
run at [aer.run](https://aer.run). Recording a run needs an account, because
something has to hold the signing key and stand behind the record.

**The client is open, and this is it.** Everything you install into your own
agents, services and CI is Apache-2.0: the collector that watches a run, the
SDKs that emit events, the guards that check attestation tokens, and the
verifier.

The split is deliberate rather than a licensing compromise. A record is only
worth something if the person reading it does not have to trust the party that
produced it, so the part that proves a record is genuine is the part you can
read, audit and run yourself. `@adastracomputing/aer-verify` makes no network
calls and needs no account: given a bundle it checks the hash, the signature and
the transparency-log evidence on your machine. If we disappeared tomorrow, every
record already issued would still verify.

So: you need an account to *produce* records. You need nothing from us to
*check* one.

Request access at [aer.run](https://aer.run).

If you are a coding agent, or you are pointing one at this repository, read
[AGENTS.md](./AGENTS.md) instead of inferring the integration from the READMEs.

## Packages

| Package | What it does | Version |
| --- | --- | --- |
| [`aer`](https://www.npmjs.com/package/@adastracomputing/aer) | Command line: set up, import runs, verify records. | ![npm](https://img.shields.io/npm/v/@adastracomputing/aer?label=%20) |
| [`aer-auto-node`](https://www.npmjs.com/package/@adastracomputing/aer-auto-node) | Auto-instrumentation for Node, no code changes. | ![npm](https://img.shields.io/npm/v/@adastracomputing/aer-auto-node?label=%20) |
| [`aer-verify`](https://www.npmjs.com/package/@adastracomputing/aer-verify) | Dependency-free verifier for signed bundles. | ![npm](https://img.shields.io/npm/v/@adastracomputing/aer-verify?label=%20) |
| [`aer-resource-node`](https://www.npmjs.com/package/@adastracomputing/aer-resource-node) | Verify attestation tokens at your API, fail-closed. | ![npm](https://img.shields.io/npm/v/@adastracomputing/aer-resource-node?label=%20) |
| [`aer-mcp-guard`](https://www.npmjs.com/package/@adastracomputing/aer-mcp-guard) | Admission control for HTTP MCP servers. | ![npm](https://img.shields.io/npm/v/@adastracomputing/aer-mcp-guard?label=%20) |
| [`aer-mcp-recorder`](https://www.npmjs.com/package/@adastracomputing/aer-mcp-recorder) | Transparent MCP proxy that records tool activity. | ![npm](https://img.shields.io/npm/v/@adastracomputing/aer-mcp-recorder?label=%20) |
| [`aer-hooks`](https://www.npmjs.com/package/@adastracomputing/aer-hooks) | Hook adapters for coding harnesses. | ![npm](https://img.shields.io/npm/v/@adastracomputing/aer-hooks?label=%20) |
| [`aer-emit`](https://www.npmjs.com/package/@adastracomputing/aer-emit) | Shared emit core used by the recorder and hooks. | ![npm](https://img.shields.io/npm/v/@adastracomputing/aer-emit?label=%20) |
| [`aer-sdk-ts`](https://www.npmjs.com/package/@adastracomputing/aer-sdk-ts) | TypeScript SDK for emitting events directly. | ![npm](https://img.shields.io/npm/v/@adastracomputing/aer-sdk-ts?label=%20) |
| [`aer_sdk`](./packages/sdk-py) | Python SDK. Installed from this repo, not npm or PyPI. | ![release](https://img.shields.io/github/v/release/Ad-Astra-Computing/aer?filter=sdk-py-v*&label=%20) |

Every library package is ESM and ships its own types. All target Node 20 or newer.

## Install

### Requirements

Node 20 or newer. An AER account for anything that records a run; nothing
for verifying one.

### Set up a Node project

```sh
npx @adastracomputing/aer init
```

On Nix, run the CLI from the flake instead:

```sh
nix run github:Ad-Astra-Computing/aer -- init
```

`init` wires the collector into the run scripts and writes `aer.config.json`,
`.env.example` and a manifest of what it changed. It does not touch
application code.

To run without npm at all, take the packages as a node_modules tree:

```sh
nix build github:Ad-Astra-Computing/aer#node-modules
ln -s ./result/lib/node_modules node_modules
```

## Usage

Run your agent with the collector loaded:

```sh
node --import @adastracomputing/aer-auto-node/register your-agent.js
```

Check the integration. `doctor` exits non-zero if anything is wrong, so it is
safe to gate on in CI:

```sh
$ npx @adastracomputing/aer doctor
AER_BASE_URL          ok    https://api.aer.run
API reachable         ok    ready (200)
tenant auth           ok
```

Then send a tiny instrumented run end to end and verify what comes out:

```sh
npx @adastracomputing/aer smoke
```

## Record a coding harness

Claude Code, Codex CLI and opencode are recorded through hooks rather than the
Node collector, since the agent is the harness rather than a script you launch:

```sh
npx @adastracomputing/aer-hooks install claude-code
```

`codex` and `opencode` work the same way. `status` shows what is wired and
`uninstall` removes it. Every config write keeps a backup.

On Nix, install the tools first so the hook binary is on `PATH`, then wire the
harness:

```sh
nix profile add github:Ad-Astra-Computing/aer#tools
aer-hooks install claude-code
```

`nix run` is not enough on its own here: it puts the binary on `PATH` only for
the length of that one command, and the harness needs `aer-hook` later, every
time it runs a tool.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `AER_API_KEY` | Yes, to record | The only secret. Never commit it |
| `AER_BASE_URL` | No | Defaults to `https://api.aer.run` |
| `AER_DISABLE` | No | Set to turn the collector off without code changes |

Non-secret identity (tenant, agent and environment) lives in
`aer.config.json`, written by `init`.

## Documentation

- [Instructions for coding agents](./AGENTS.md)
- [What is in a record](./docs/concepts/what-is-in-a-record.md)
- [Bodies-off](./docs/concepts/bodies-off.md)
- [Verifying a record](./docs/concepts/verifying-a-record.md)
- [Attestation and admission control](./docs/concepts/attestation.md)

Each package carries its own README with its full API.

## Verifying a record

Verification is the part that needs nothing from us. `aer-verify` recomputes the
bundle hash, checks the Ed25519 signature and evaluates the transparency-log
evidence. The library itself makes no network calls, so you can check a bundle
you already hold. The command below fetches the bundle and the public key first,
then does all of the checking locally.

```sh
npx @adastracomputing/aer verify <aer-id>
```

## Python SDK

[![latest Python SDK release](https://img.shields.io/github/v/release/Ad-Astra-Computing/aer?filter=sdk-py-v*&label=python%20sdk)](https://github.com/Ad-Astra-Computing/aer/releases?q=sdk-py)

The Python SDK lives in [`packages/sdk-py`](./packages/sdk-py) and imports as
`aer_sdk`. It is stdlib-only and needs Python 3.10 or newer.

It is not published to PyPI, and there is no plan to publish it. The package is
maintained here and installed from this repository, which keeps one source of
truth for it rather than a copy that drifts from the code under test.

```sh
pip install "git+https://github.com/Ad-Astra-Computing/aer.git#subdirectory=packages/sdk-py"
```

With Nix, take it as a flake output rather than a git URL:

```nix
inputs.aer.url = "github:Ad-Astra-Computing/aer";

# then, in your own package set
python3.withPackages (ps: [ aer.packages.${system}.sdk-py ])
```

## Development

With [Nix](https://nixos.org), `nix develop` gives a shell with Node, pnpm,
Python and pytest. Otherwise install Node 20 or newer and pnpm 11.

```sh
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r typecheck
```

Agents working in this repository should read [AGENTS.md](./AGENTS.md).
Contribution guidelines are in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Testing

```sh
pnpm -r test
nix flake check
```

`nix flake check` builds, typechecks and tests every workspace member inside
the sandbox with no network, and builds the Python SDK with its own suite.

Releases are managed with
[changesets](https://github.com/changesets/changesets): a change that should
ship includes a changeset file, CI opens a version pull request that bumps
versions and changelogs, and merging it publishes to npm. Publishing uses npm
trusted publishing over OIDC, so no npm token exists in this repository or in
its secrets.

Every package here is pre-1.0, so a release publishes to the `next` dist-tag,
not `latest`. A version that has only just been cut has not been proven by
anyone yet, and `latest` is what an unpinned `npm install` resolves to, so
moving it is a claim about maturity rather than a side effect of merging a pull
request. Install a fresh release explicitly:

```sh
npm install @adastracomputing/aer@next
```

Once a version has run somewhere real, promote it:

```sh
pnpm promote                      # show what would move, change nothing
pnpm promote @adastracomputing/aer --yes
```

`latest` moves only through that second command.

One consequence to be deliberate about: a fix sits on `next` until someone
promotes it, and that includes a security fix. `latest` is what the quick start
above resolves, so promoting is part of shipping a security patch, not a
follow-up chore.

## Nix

The root `flake.nix` provides:

- `devShells.default`: Node 24, pnpm, Python 3 and pytest.
- `packages.<name>`: one output per publishable npm package, each building the
  exact tarball `npm publish` would produce, for example
  `nix build .#aer-verify`. Workspace dependencies are vendored once from
  `pnpm-lock.yaml`, so builds are offline and reproducible after the first
  fetch.
- `apps.aer`, `apps.aer-hooks`, `apps.aer-hook`, `apps.aer-mcp-recorder`: every
  binary the packages ship, runnable with `nix run .#<name>`. Libraries have no
  app output because there is nothing to run.
- `packages.tools`: all of those binaries in one output, for
  `nix profile add github:Ad-Astra-Computing/aer#tools` or a devShell. Use
  this rather than `nix run` when wiring a coding harness: the hook config
  invokes a bare `aer-hook`, so that binary has to be on `PATH` at the moment
  the harness runs a tool, which an ephemeral `nix run` cannot provide.
- `packages.sdk-py`: the Python SDK as an installable Python package. Its test
  suite and an import check run as part of the build.
- `checks`: `nix flake check` builds, typechecks and tests the whole workspace
  inside the sandbox with no network, and builds the Python SDK.

`@aer/schemas` and the internal test utilities are intentionally not published
and not exposed as flake outputs. They are workspace-only dependencies used at
build time, never a runtime dependency of anything that ships.

## Security

Report a vulnerability through [SECURITY.md](./SECURITY.md). Please do not open
a public issue for a security report.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

The AER service is a hosted product and is not open source. The client packages
in this repository are licensed under Apache-2.0 (SPDX: `Apache-2.0`),
copyright Ad Astra Computing Inc. See [LICENSE](./LICENSE).
