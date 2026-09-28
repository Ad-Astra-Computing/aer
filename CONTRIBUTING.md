# Contributing

Bug reports and small fixes are welcome. Opening an issue first is the fastest
way to get a change in.

These packages are developed alongside the AER service, and accepted changes
are released through that process. A pull request may therefore land as a
separate commit rather than a direct merge, with credit in the changelog.

Before submitting a change, run:

```sh
pnpm install
pnpm test
```

For anything security related, see [SECURITY.md](./SECURITY.md).

## Before a release

The installed-package matrix tests every client package the way a customer
gets it: packed or downloaded, installed with npm into a throwaway directory
and driven through its installed binaries against a local capture server. It
never contacts the AER service.

```sh
pnpm matrix                                           # local tarballs
pnpm matrix --source registry --tag next              # what is on npm
pnpm matrix --source registry --tag next --upgrade-from latest
```

The matrix must pass against `--source local` before a release pull request
merges, and against `--source registry --tag next`, with the upgrade run from
`latest`, before `pnpm promote` moves `latest`. A known issue is reported as
KNOWN rather than hidden; any FAIL blocks. Run `pnpm matrix --help` for the
filters and the JSON report.

Two suites drive third-party software end to end at pinned versions, installed
from npm once per run, so their setup needs the registry the way the LLM SDK
cases do:

- `vercel-ai` runs the real `ai` package with `@ai-sdk/openai` and
  `@ai-sdk/anthropic` under the collector's register hook, against a local
  server that speaks each provider's own wire format, streaming included. It
  covers `generateText`, `streamText` read to the end and aborted midway,
  `generateObject` and `streamObject`, a tool loop, a provider the collector
  does not instrument (`@ai-sdk/openai-compatible`), a usage policy in block
  mode and an unreachable AER API.
- `opencode` installs the real `opencode-ai` binary, wires the plugin file
  from the `aer-hooks` README into a throwaway project and runs `opencode run`
  against a local OpenAI-compatible model server that answers with tool calls,
  so opencode runs `bash` and `read` itself. It checks the recorded session,
  tools, programs, file, model and token counts and the completion when
  opencode exits. It also checks that no content reaches the record and that
  opencode is unaffected when the AER API is down or the plugin is
  unconfigured. opencode is a Bun binary rather than Node; Bun honours the
  same proxy variables, so the network guard below covers it too.

The pins sit at the top of `scripts/matrix/cases/vercel-ai.mjs` and
`scripts/matrix/cases/opencode.mjs`. They are printed at the end of a run and
recorded under `thirdParty` in the JSON report, so moving to a newer SDK or
opencode release is a deliberate change to one of those tables.

No case may reach the AER service. The runner drops every `AER_*` variable it
was started with, refuses to start a child whose environment or arguments name
`api.aer.run`, and routes each case process's non-loopback traffic to a proxy
that nothing listens on. That proxy relies on Node's `NODE_USE_ENV_PROXY`, which
covers both `fetch` and `node:http(s)` only from Node 22.21 and 24.5 (never 23),
so the matrix refuses to start on an older Node. The `harness` suite checks the
guard first on every run, and if any of its cases fails no other suite runs.

The one exception is `--live`, off by default. A positive `aer verify` verdict
needs a record signed by a key in the CLI's pinned production trust root, and
the CLI has no way to swap that root on purpose, since a swappable root would
let a forged bundle print `verified`. `pnpm matrix --only live --live` checks
the newest public demo record on `api.aer.run` with the installed CLI, using
public reads only and no credential. Run it before `pnpm promote`. Positive
verdicts with self-minted keys are covered offline through the
`@adastracomputing/aer-verify` library.

With `--live`, the live suite can also run the Vercel AI SDK path against a
real provider, but only when a key is supplied explicitly in the environment of
that run: `MATRIX_OPENAI_API_KEY` or `MATRIX_ANTHROPIC_API_KEY`, with
`MATRIX_OPENAI_MODEL` or `MATRIX_ANTHROPIC_MODEL` to choose the model. No key
is ever read from disk. The record still goes to a local sink, and without a
key those cases are reported as SKIP.
