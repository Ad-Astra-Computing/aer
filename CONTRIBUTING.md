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

- `vercel-ai` runs the real `ai` package with `@ai-sdk/openai`,
  `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/mistral` and `@ai-sdk/groq`
  under the collector's register hook, against a local server that speaks each
  provider's own wire format, streaming included. It
  covers `generateText`, `streamText` read to the end and aborted midway,
  `generateObject` and `streamObject`, a tool loop, a provider the collector
  does not instrument (`@ai-sdk/openai-compatible`), a usage policy in block
  mode, an unreachable AER API and one that accepts connections and never
  answers.
- `opencode` installs the real `opencode-ai` binary, wires the plugin file
  from the `aer-hooks` README into a throwaway project and runs `opencode run`
  against a local OpenAI-compatible model server that answers with tool calls,
  so opencode runs `bash` and `read` itself. It checks the recorded session,
  tools, programs, file, model and token counts and the completion when
  opencode exits. It also checks that no content reaches the record and that
  opencode is unaffected when the AER API is down or the plugin is
  unconfigured. opencode is a Bun binary rather than Node; Bun honours the
  same proxy variables, so the network guard below covers it too.

  opencode installs `@opencode-ai/plugin` into each config directory when it
  starts, and with the registry blocked it retries for about a minute. The
  suite installs that package once per run and seeds each case's `.opencode`
  and global config directories with its `package.json`, lockfile and a
  symlink to its `node_modules`. A real machine has a real `node_modules`
  there, not a symlink. If a later opencode release reinstalls or rejects the
  seed, the suite slows down or fails for that reason; check the seed before
  suspecting the plugin.

The pins sit at the top of `scripts/matrix/cases/vercel-ai.mjs` and
`scripts/matrix/cases/opencode.mjs`. They are printed at the end of a run and
recorded under `thirdParty` in the JSON report, so moving to a newer SDK or
opencode release is a deliberate change to one of those tables.

Three suites drive the coding harnesses the hooks support, for real and in
both of the ways a person runs them: headless, and the interactive TUI driven
through a pseudo-terminal (util-linux `script`, so no native module is
needed). Each wires the hooks with `aer-hooks install <harness> --env-file`
into a throwaway home, as the `aer-hooks` README recommends, and asserts one
completed record with the tools, programs, hosts, files and model the run
produced, with no prompt, argument, file content or answer in it.

- `codex` installs `@openai/codex` from npm at a pinned version and points
  it at a local server that speaks the OpenAI Responses protocol and answers
  with tool calls, so Codex runs a shell line and writes a file through
  `apply_patch` itself. It covers `codex exec` (hook trust granted with
  `--dangerously-bypass-hook-trust`, and without it, where nothing may be
  recorded), `CODEX_HOME`, an API as slow as the real one, an unreachable
  API, and the TUI with and without its background app-server daemon, trust
  granted at its startup review.
- `antigravity` drives the `agy` on PATH (nixpkgs `antigravity-cli`; there
  is no npm package, so its version is recorded rather than pinned) in its
  Gemini API key mode against a local Gemini-protocol server, so no Google
  account is needed. It covers `agy -p`, a slow and an unreachable API, and
  the TUI, including agy's first-run onboarding and a two-turn conversation.
- `claude-code` drives the signed-in `claude` on PATH with
  `--setting-sources project`, so it loads only the throwaway project's
  settings, where the hooks are wired. Its model calls go to the real
  Anthropic API through that sign-in, which the matrix never reads, on the
  cheapest model, through a proxy that allows `api.anthropic.com` alone. It
  covers `claude -p` and the TUI, each also with the SessionEnd `timeout`
  key removed against a slow API. These cases are marked
  `requires: claude-login`: they are reported as SKIP where `claude` is
  missing or signed out, and under CI (when `CI` is set) they run only with
  `--with claude-login`. `--without claude-login` skips them anywhere.

The Codex pin sits at the top of `scripts/matrix/cases/codex.mjs`. The
versions of every harness a run drove are printed at the end and recorded
under `thirdParty` in the JSON report. To see which harness modes a released
`aer-hooks` handles, run the same suites against it:
`pnpm matrix --source registry --tag latest --only codex,claude-code,antigravity`.

No case may reach the AER service. The runner drops every `AER_*` variable it
was started with, refuses to start a child whose environment or arguments name
`api.aer.run`, and routes each case process's non-loopback traffic to a proxy
that nothing listens on. That proxy relies on Node's `NODE_USE_ENV_PROXY`, which
covers both `fetch` and `node:http(s)` only from Node 22.21 and 24.5 (never 23),
so the matrix refuses to start on an older Node. The `harness` suite checks the
guard first on every run, and if any of its cases fails no other suite runs.
The `claude-code` suite, whose harness must reach its model provider, gets an
allowlisting proxy in place of that one: it opens a tunnel to
`api.anthropic.com` and refuses everything else, the AER API included.

The one exception is `--live`, off by default. A positive `aer verify` verdict
needs a record signed by a key in the CLI's pinned production trust root, and
the CLI has no way to swap that root on purpose, since a swappable root would
let a forged bundle print `verified`. `pnpm matrix --only live --live` checks
the newest public demo record on `api.aer.run` with the installed CLI, using
public reads only and no credential. Run it before `pnpm promote`. Positive
verdicts with self-minted keys are covered offline through the
`@adastracomputing/aer-verify` library.

With `--live`, the `vercel-ai-live` suite runs the Vercel AI SDK path against
a real provider rather than api.aer.run, with
`pnpm matrix --only vercel-ai-live --live`. It runs only when a key is supplied
explicitly in the environment of that run, `MATRIX_OPENAI_API_KEY` or
`MATRIX_ANTHROPIC_API_KEY`, with `MATRIX_OPENAI_MODEL` or
`MATRIX_ANTHROPIC_MODEL` to choose the model. No key is ever read from disk.
The record still goes to a local sink. Without a key those cases are reported
as SKIP.

## Test settings of the hooks

`AER_HOOK_DRAIN_BUDGET_MS` shortens how long the background process that
finishes a session end may run, so a test can watch it give up and exit
without waiting out the full minute. It can only lower that budget, never
raise it, and is not meant for use outside tests.
