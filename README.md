# AER client packages

Client-side packages for [AER](https://aer.run), published to npm under the
`@adastracomputing` scope. This is the code you install into your own agents
and services.

AER (Agent Execution Record) gives every agent run a signed, tamper-evident
record of what the agent actually did: the tools it called, the models it hit,
the network egress it made. You can verify a record offline, gate MCP servers on
attested agents and hand auditors a bundle they can check themselves.

Using these packages requires an AER account. Request access at
[aer.run](https://aer.run). Verifying a published record with
`@adastracomputing/aer-verify` needs no account at all.

## Packages

| Package | What it does | npm |
| --- | --- | --- |
| `@adastracomputing/aer` | Command line: wire up auto-instrumentation, import runs, verify records. | [npm](https://www.npmjs.com/package/@adastracomputing/aer) |
| `@adastracomputing/aer-auto-node` | Drop-in auto-instrumentation for Node. AER records what your agent is doing, with no manual emit calls. | [npm](https://www.npmjs.com/package/@adastracomputing/aer-auto-node) |
| `@adastracomputing/aer-verify` | Dependency-free verifier for signed AER bundles. Runs in Node, Workers and the browser. | [npm](https://www.npmjs.com/package/@adastracomputing/aer-verify) |
| `@adastracomputing/aer-resource-node` | Verify AER attestation tokens at a protected resource, offline against cached JWKS, fail-closed. | [npm](https://www.npmjs.com/package/@adastracomputing/aer-resource-node) |
| `@adastracomputing/aer-mcp-guard` | Admission control for HTTP MCP servers. Only attested agents reach your tools. | [npm](https://www.npmjs.com/package/@adastracomputing/aer-mcp-guard) |
| `@adastracomputing/aer-mcp-recorder` | Transparent MCP proxy that records tool activity without harness integration. | [npm](https://www.npmjs.com/package/@adastracomputing/aer-mcp-recorder) |
| `@adastracomputing/aer-hooks` | Hook adapters that record coding-harness tool events (Claude Code, Codex CLI, opencode). | [npm](https://www.npmjs.com/package/@adastracomputing/aer-hooks) |
| `@adastracomputing/aer-emit` | Shared best-effort emit core used by the recorder and hooks. | [npm](https://www.npmjs.com/package/@adastracomputing/aer-emit) |
| `@adastracomputing/aer-sdk-ts` | TypeScript SDK for emitting agent execution events directly. | [npm](https://www.npmjs.com/package/@adastracomputing/aer-sdk-ts) |

## Quickstart

Set up auto-instrumentation in a Node project:

```sh
npx @adastracomputing/aer init
```

Then run your agent with the collector loaded:

```sh
node --import @adastracomputing/aer-auto-node/register your-agent.js
```

## Development

With [Nix](https://nixos.org), `nix develop` gives a shell with Node and pnpm.
Otherwise install Node 20+ and pnpm 10 yourself.

```sh
pnpm install
pnpm -r build
pnpm -r test
```

Releases are managed with [changesets](https://github.com/changesets/changesets):
a change that should ship includes a changeset file, CI opens a version pull
request that bumps versions and changelogs, and merging it publishes to npm.

## License

The AER service is a hosted product and is not open source. The client packages
in this repository are licensed under Apache-2.0. See [LICENSE](./LICENSE).
