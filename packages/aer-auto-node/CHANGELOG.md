# Changelog

## 0.3.1

### Patch Changes

- [`bb2e4dd`](https://github.com/Ad-Astra-Computing/aer/commit/bb2e4dd974f34fbbdb5d6e991c2f5dd31c118430) - collector: join the records one run produces

  A process that spawns worker threads gets a collector per thread and a signed
  record per thread. Every `collector.report` now carries a run id, shared across
  the threads and child processes of one run, plus the pid and thread it was
  written on, so the records can be put back together.

  A quiet adapter is no longer reported as `idle` when the session made
  model-shaped requests to hosts no adapter claims. It reads `unverifiable`,
  because `idle` would be a signed claim that no model traffic happened.
- [`a5c0f98`](https://github.com/Ad-Astra-Computing/aer/commit/a5c0f98e8c0ef06784bca0be61557e6a2d4fbdbf) - collector: do not lose a completion to the close that raced it

  The adapter observes the SDK's promise rather than replacing it, to keep the
  SDK's own promise type. Adopting a foreign thenable costs extra microtask
  ticks, so the caller's `await` could run first, complete the session, and
  flush before `llm.completed` was emitted. The record then showed a model call
  that was requested and never finished, losing the model and the token counts
  with it. Anthropic's `APIPromise` lost this race most often.

  Completing a session now waits for the observations already in flight.

  A second cause sat underneath it. `drain` returned early when a send was
  already in flight, and the close path called that same `drain`, so an event
  captured mid-send stayed in the queue and the session closed without it. A
  drain now joins the send already running and keeps going until the queue is
  empty, so a completion that arrives during a flush is still delivered.
- [`efda1bf`](https://github.com/Ad-Astra-Computing/aer/commit/efda1bf607c6ef0e481ec4c65d982ce72db2f010) - Record LLM calls from an ESM agent, and stop claiming adapters that recorded nothing

  Three faults, found by testing the collector against the real SDKs in a real
  install rather than against objects shaped like them.

  **A project with the Vercel AI SDK installed crashed at startup.** `ai` is ESM
  and an ESM module namespace is frozen, so writing the patch marker to it threw,
  uncaught, out through the register entry point before the application ran a
  line. Adapter installation is now isolated per adapter and a target that cannot
  be patched is reported rather than thrown.

  **The OpenAI and Anthropic adapters recorded nothing in an ESM agent.** Both
  packages are dual-published: `index.mjs` and `index.js` are different classes
  with different prototypes. The collector reached the SDK with `createRequire`,
  so it patched the CJS copy while the application imported the other one. The
  signed record carried no model and no token counts, while its own
  `collector.report` listed both adapters as active. Resolution is now anchored to
  the application, and every copy the application could use is patched before its
  first call. `enabled` now means patched rather than present, so the report stops
  naming an adapter that records nothing.

  **The Vercel AI SDK was not instrumented at all.** It is now recorded at the
  provider layer: one `doGenerate` is one real model call, with the model id and
  the token counts. Streaming records the call but not its counts, which arrive in
  a stream part this release does not read.

  If you run an ESM agent, records produced before this release are missing their
  `llm.requested` and `llm.completed` events. Those records are signed and are not
  rewritten; new sessions are complete.

  Security review before publishing found three more, all fixed here.

  The collector crashed at startup on Node older than 22.15. It imported
  `registerHooks` from `node:module` as a named import, and a missing named
  export from a builtin is a link error rather than undefined, so the guard
  beneath it never ran. The process died before the application loaded, and
  before `AER_DISABLE` was read.

  `spawn(line, [], { shell: true })` skipped the command reducer entirely,
  because an argv array was read as proof that argv[0] was a program path. That
  put the tail of the line back in the record: a redirect target, an scp target,
  or whatever followed a semicolon. cross-spawn and execa both pass an array and
  forward `shell`, so this was the common shape.

  A record could assert instrumentation coverage a run did not have. Tearing the
  collector down left every adapter listed as patched, so the closing report read
  as a run that made no calls; a wrapper replaced after installation was not
  noticed at all; and a provider host two adapters could both have called was
  read as a contradiction against whichever one did not record it.
- [`7f9d050`](https://github.com/Ad-Astra-Computing/aer/commit/7f9d050e186fc7faf57e8b403ecda79c37df119a) - Stop recording part of a shell command line as the program that ran

  The reducer that turns a shell command into a program name split the line on
  whitespace and took the first token. That is not how a shell reads a line, and
  in several ordinary cases the token it picked was not the program:

  - `MSG="hello world" notify` recorded `world`, because the skip over the
    leading assignment stepped one whitespace token at a time and landed inside
    the quoted value. An inline credential recorded the credential.
  - `ls;cat /etc/shadow`, `ls&&curl example.com` and `ls|grep secret` recorded
    `shadow`, `example.com` and `secret`: an operator glued to a token hid the
    command boundary entirely.
  - `ls>/tmp/private-name` recorded the redirect target, and `2>/dev/null cmd`
    recorded `null`.
  - A bare URL or an scp-style target recorded its last path segment.

  The collector had a second route to the same outcome. It decided whether
  argv[0] was a whole shell line by testing it for whitespace, so
  `spawn('ls>/tmp/private-name', { shell: true })` was treated as a program path
  and reduced with `basename`.

  Both now use one quote-aware parser that honours quoting, escapes, operators
  and redirections, and answers `unknown` whenever it did not fully understand
  the line. A partial parse states something false about what ran, which is
  worse than saying nothing. The collector also reads the `shell` option rather
  than guessing from whitespace.

  These values reach a signed record, so anyone who imported a transcript or ran
  the collector over a shell command in one of these shapes has records naming
  something other than the program that ran. New records are correct; existing
  ones are not rewritten, because a signed record is not editable.

## 0.3.0

### Minor Changes

- [`a08ab65`](https://github.com/Ad-Astra-Computing/aer/commit/a08ab65acef0b3bf1edbe731163b7c5bfeb659a2) - The collector declares its name, version and event-schema capability when it
  opens a session, and http.completed events carry the response size from
  Content-Length where the server sent one.

### Patch Changes

- [`2ca1b28`](https://github.com/Ad-Astra-Computing/aer/commit/2ca1b28d83bd8f8c74761afd2591de13f40ee538) - Fixed a secret leak: a named import of `child_process.exec` (or
  `promisify(exec)`) recorded the full, unredacted shell command in the signed
  record instead of just the executable name. Command capture is now
  path-independent, so every import style records only a basename and a
  redacted argument count.
  
  Also fixed `protected_resources` host matching: a bare host entry
  (`api.example.com`) now matches that host only, not its subdomains. A
  leading dot (`.api.example.com`) remains the only way to opt a resource into
  subdomain matching, matching what the README already documented.

- [`ba4542f`](https://github.com/Ad-Astra-Computing/aer/commit/ba4542f9d694407a9c12001a38bef15531b8726f) - README now states the package is ESM only and lists its Node floor. Also
  reworded the `[aer:auto] not started` console message and a few JSDoc
  comments to drop an em dash, with no change in behavior.

- [`682c36b`](https://github.com/Ad-Astra-Computing/aer/commit/682c36b56586d33cf0dc0cf57a922c1df42ff7bb) - Exec command strings are no longer double-captured. Node's `exec()` calls its
  own patched `execFile()` internally, and the reentrant capture recorded the
  raw shell string (including flags and secrets) in addition to the redacted,
  basename-only command.

## 0.2.0 - 2026-07-20

### Changed

- Default API base URL is now `https://api.aer.run` (was
  `https://aer-api.adastra.computer`). Both hosts serve the same API; set
  `AER_BASE_URL` to override.

### Added

- **Content commitments.** When a customer commitment key is configured
  (`AER_COMMITMENT_KEY`, at least 32 bytes), the collector commits to the LLM
  request and response it observes at the trust boundary and signs those
  commitments into the record. Each commitment is a one-way HMAC tag computed under
  the customer-held key: AER holds neither the key nor the plaintext, so it can
  neither open nor brute-force a tag. Without a key the collector emits no
  commitments; there is deliberately no bare-hash fallback, which would be a
  low-entropy oracle. The tags are:
  - `prompt_canon_tag` over a canonicalized request (`aer-canon.v1`), which
    normalizes OpenAI and Anthropic request shapes to the same tag for the same
    logical prompt.
  - `response_tag` over the assembled response text, for both streaming and
    non-streaming responses.
  - `wire_canon_tag` (`aer-wire.v1`) over the canonicalized full request body,
    sampling parameters and all. It commits to the canonicalized request object
    (sorted keys, NFC-normalized string values), not the exact serialized wire
    bytes, and complements the semantic `prompt_canon_tag`.
  - `tool_args_tag` for each tool call the model emits, and `tool_result_tags` over
    the tool outputs fed back into a request, each correlated to its request.

  Every tag carries a non-secret `kid` identifying which key produced it, so a
  verifier knows which key to check and keys can rotate. A new `./commitment`
  subpath export exposes the canonicalization and tagging primitives for
  independent verification (see `aer commitments verify` in the CLI). The whole
  path is best-effort and fail-open: a fault degrades to a name-only event or a
  "response not captured" marker and never breaks the host SDK call.

- **Usage-policy enforcement.** The collector fetches the agent's usage policy at
  session open (`GET /v1/agents/:agent_id/usage-policy`) and enforces it against
  every LLM call: allow or deny models by glob, cap calls and tokens per session.
  In `report` mode it emits a `policy.violation` event and lets the call proceed;
  in `block` mode it throws `AerPolicyError` before the SDK call happens. Token
  budgets are always reported after the response, never thrown. One `policy.applied`
  event records the governing policy. Policy events carry the model name and counts
  only, never content. The fetch is best-effort and fail-open: an unreachable
  policy endpoint disables enforcement for that session and never blocks session
  open. Enforcement is bypassable by removing the collector: it stops runaway and
  misconfigured agents, not a hostile operator, for which the strong control is
  attestation scopes at a protected LLM gateway. New exports: `AerPolicyError`,
  `PolicyEnforcer`, `matchModel` and the `UsagePolicy` / `PolicyMode` /
  `PolicyViolation` / `PolicyRule` types.
- **Principal attribution.** Attach the identity a run acts on behalf of via
  `AER_PRINCIPAL_ID` / `AER_PRINCIPAL_KIND` (user, service or ci, defaults to
  user) / `AER_PRINCIPAL_DISPLAY`, a `principal` key in `aer.config.json` or a
  per-task `withAerSession({ principal })` override. It is optional, opaque and
  signed into the record. A run without one sends the exact same create-session
  request as before.

## 0.1.0 - 2026-07-11

First public release. A drop-in, near-zero-config auto-instrumentation collector
for Node agents: install it, run your agent with the register hook, and it
produces a signed Agent Execution Record of what the agent did. Everything it
captures is metadata only.

### Capture

- **Transport.** Patches `globalThis.fetch`, `node:http(s)` and
  `node:child_process` to record outbound HTTP and spawned processes.
- **Semantic LLM/tool adapters** (auto-enabled when the SDK is detected):
  OpenAI (`openai`), Anthropic (`@anthropic-ai/sdk`) and the Vercel AI SDK
  (`ai`). Emits `llm.requested`, `llm.completed` and `tool.selected` from
  structured metadata: provider, model, token counts, finish or stop reason and
  tool names.
- **Streaming metadata.** OpenAI and Anthropic streams are tapped in place by
  shadowing the response's async iterator (no backpressure change, stream
  identity preserved); the Vercel AI SDK is observed through its result
  `usage` / `finishReason` / `toolCalls` promises. `usage_observed` reports
  whether token counts were available (tokens only).
- **Collector report.** A final `collector.report` carries per-provider
  `adapter_activity` (calls, ok, error, tool selections), attestation and egress
  counters and coverage metadata.

### Privacy boundary

No prompts, generated text, content deltas, tool arguments, request or response
bodies or headers are ever captured, on any provider, streaming or not.

### Attestation and admission

- AER Attestation injection on protected resources, so the agent's outbound
  requests carry a short-lived verifiable token.
- DPoP and mTLS-bound attestation support (`cnf.jkt` / `cnf.x5t#S256`).
- Per-resource egress enforcement modes: `off`, `report`, `block`.

### Known limitations

- SDK adapters are duck-typed against the providers' current shapes and soft-fail
  on drift (an unrecognized call degrades rather than throwing).
- Token usage is reported only when the provider exposes it; some streaming modes
  do not (for example OpenAI without `stream_options.include_usage`).
- Vercel streaming capture reads result metadata, not stream chunks.
- Raw sockets, DNS and other non-HTTP egress are out of scope.
