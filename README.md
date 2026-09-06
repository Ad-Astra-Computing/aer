<p align="center">
  <img src=".github/assets/aer-mark.svg" width="88" height="88" alt="AER">
</p>

<h1 align="center">AER client packages</h1>

<p align="center">
  A signed, tamper-evident record of what an AI agent actually did.
</p>

<p align="center">
  <a href="https://github.com/Ad-Astra-Computing/aer/actions/workflows/ci.yml"><img src="https://github.com/Ad-Astra-Computing/aer/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/org/adastracomputing"><img src="https://img.shields.io/npm/v/@adastracomputing/aer?label=cli" alt="CLI version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache-2.0"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node 20 or newer">
  <img src="https://img.shields.io/badge/types-included-blue" alt="TypeScript types included">
</p>

---

AER (Agent Execution Record) gives every agent run a signed record of the tools
it called, the models it hit and the network egress it made. You can verify a
record offline, gate MCP servers on attested agents and hand an auditor a bundle
they can check without trusting you or us.

This repository holds the client side: the code you install into your own agents
and services. The service itself is a hosted product and is not open source.

Using these packages requires an AER account. Request access at
[aer.run](https://aer.run). Verifying a published record with
`@adastracomputing/aer-verify` needs no account at all.

## Packages

| Package | What it does | Version |
| --- | --- | --- |
| [`aer`](https://www.npmjs.com/package/@adastracomputing/aer) | Command line: wire up auto-instrumentation, import runs, verify records. | ![npm](https://img.shields.io/npm/v/@adastracomputing/aer?label=%20) |
| [`aer-auto-node`](https://www.npmjs.com/package/@adastracomputing/aer-auto-node) | Drop-in auto-instrumentation for Node, with no manual emit calls. | ![npm](https://img.shields.io/npm/v/@adastracomputing/aer-auto-node?label=%20) |
| [`aer-verify`](https://www.npmjs.com/package/@adastracomputing/aer-verify) | Dependency-free verifier for signed bundles. Node, Workers and the browser. | ![npm](https://img.shields.io/npm/v/@adastracomputing/aer-verify?label=%20) |
| [`aer-resource-node`](https://www.npmjs.com/package/@adastracomputing/aer-resource-node) | Verify attestation tokens at a protected resource, offline, fail-closed. | ![npm](https://img.shields.io/npm/v/@adastracomputing/aer-resource-node?label=%20) |
| [`aer-mcp-guard`](https://www.npmjs.com/package/@adastracomputing/aer-mcp-guard) | Admission control for HTTP MCP servers. Only attested agents reach your tools. | ![npm](https://img.shields.io/npm/v/@adastracomputing/aer-mcp-guard?label=%20) |
| [`aer-mcp-recorder`](https://www.npmjs.com/package/@adastracomputing/aer-mcp-recorder) | Transparent MCP proxy that records tool activity with no harness integration. | ![npm](https://img.shields.io/npm/v/@adastracomputing/aer-mcp-recorder?label=%20) |
| [`aer-hooks`](https://www.npmjs.com/package/@adastracomputing/aer-hooks) | Hook adapters for coding harnesses (Claude Code, Codex CLI, opencode). | ![npm](https://img.shields.io/npm/v/@adastracomputing/aer-hooks?label=%20) |
| [`aer-emit`](https://www.npmjs.com/package/@adastracomputing/aer-emit) | Shared best-effort emit core used by the recorder and hooks. | ![npm](https://img.shields.io/npm/v/@adastracomputing/aer-emit?label=%20) |
| [`aer-sdk-ts`](https://www.npmjs.com/package/@adastracomputing/aer-sdk-ts) | TypeScript SDK for emitting execution events directly. | ![npm](https://img.shields.io/npm/v/@adastracomputing/aer-sdk-ts?label=%20) |

Every library package is ESM and ships its own types. All target Node 20 or newer.

## Quickstart

Set up auto-instrumentation in a Node project:

```sh
npx @adastracomputing/aer init
```

Then run your agent with the collector loaded:

```sh
node --import @adastracomputing/aer-auto-node/register your-agent.js
```

Check the integration, then send a tiny run end to end:

```sh
npx @adastracomputing/aer doctor
npx @adastracomputing/aer smoke
```

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
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm -r test
```

Releases are managed with
[changesets](https://github.com/changesets/changesets): a change that should
ship includes a changeset file, CI opens a version pull request that bumps
versions and changelogs, and merging it publishes to npm. Publishing uses npm
trusted publishing over OIDC, so no npm token exists in this repository or in
its secrets.

## Nix

The root `flake.nix` provides:

- `devShells.default`: Node 24, pnpm, Python 3 and pytest.
- `packages.<name>`: one output per publishable npm package, each building the
  exact tarball `npm publish` would produce, for example
  `nix build .#aer-verify`. Workspace dependencies are vendored once from
  `pnpm-lock.yaml`, so builds are offline and reproducible after the first
  fetch.
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
in this repository are licensed under Apache-2.0. See [LICENSE](./LICENSE).
