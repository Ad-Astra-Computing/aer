# Changelog

## 0.6.0

### Minor Changes

- [`948d8f2`](https://github.com/Ad-Astra-Computing/aer/commit/948d8f29587619308bd46650b20bacc84f471da8) - The usage policy is now fetched when the collector starts, for the
  configured agent, instead of by every session when its first call arrived.
  A session for another agent fetches that agent's policy when its first
  session starts. The answer is kept per agent for the process; each session
  keeps the policy it started with, and a session started more than 5 minutes
  after the last fetch starts a refresh and uses the previous answer until it
  arrives. A block-mode policy therefore governs the first call of a process
  too, on the OpenAI, Anthropic and Vercel AI SDK paths. The only call that
  can wait is one made while the first fetch for its agent is still in flight:
  it waits for the answer, never more than 3 seconds after the fetch started,
  and then goes ahead ungoverned if none came. Once an answer has arrived no
  call waits, whatever the mode.
- [`948d8f2`](https://github.com/Ad-Astra-Computing/aer/commit/948d8f29587619308bd46650b20bacc84f471da8) - The collector now tells an agent with no usage policy (404) apart from a
  policy it could not fetch. A failed fetch is retried after 30 seconds instead
  of being treated as "no policy". When a refresh fails, the last policy fetched
  keeps governing new sessions; once it is more than 5 minutes old and the
  latest refresh has failed, a block-mode policy that says
  `on_unavailable: fail_closed` refuses every LLM call in new sessions with
  rule `policy_unavailable`. When the first fetch fails and no policy was ever
  fetched, sessions run ungoverned until a fetch succeeds.
- [`948d8f2`](https://github.com/Ad-Astra-Computing/aer/commit/948d8f29587619308bd46650b20bacc84f471da8) - Vercel AI SDK calls are now recorded completely. A streamed call
  (`streamText`, `streamObject`) records its token counts and finish reason
  when your code has read the stream, instead of completing without them the
  moment the stream opened. A stream that fails or is aborted is recorded as a
  failed call rather than a success. Tool calls the model makes are recorded as
  `tool.selected` with the tool name, streamed or not. A usage policy in block
  mode now applies on the Vercel path too, so a call to a denied model that
  used to go through now throws `AerPolicyError` before the request is sent.

### Patch Changes

- [`948d8f2`](https://github.com/Ad-Astra-Computing/aer/commit/948d8f29587619308bd46650b20bacc84f471da8) - A tool name the model returns is now recorded only when the record can keep
  it: a string of at most 200 UTF-16 code units with no control characters.
  The AER API accepts names up to 512, but a longer name would break the
  commitment the record keeps for that call's tool arguments. Any other name
  is recorded as `(unrecordable tool name)` and counted in that provider's
  `tool_names_replaced` in `adapter_activity`, so a model that returns an
  oversized or malformed name no longer gets the whole `tool.selected` event
  refused. This applies to the OpenAI, Anthropic and Vercel AI SDK paths,
  streamed or not.
- [`948d8f2`](https://github.com/Ad-Astra-Computing/aer/commit/948d8f29587619308bd46650b20bacc84f471da8) - When a batch of events cannot be delivered to the AER API (refused, failed
  or timed out), the final `collector.report` now counts its events in
  `events_dropped_budget`, so the record says it is short instead of looking
  complete. A batch that timed out may still have arrived, so the count is an
  upper bound. The field is absent when every batch arrived.
- [`948d8f2`](https://github.com/Ad-Astra-Computing/aer/commit/948d8f29587619308bd46650b20bacc84f471da8) - Every request the collector makes to the AER API is now abandoned after 10
  seconds. An API that accepted the connection and never answered used to keep
  the host process from exiting at all; it now delays exit by up to about 30
  seconds, since the last batch, the closing report and the completion are
  sent one after another.

## 0.5.0

### Minor Changes

- [`f0fcbcb`](https://github.com/Ad-Astra-Computing/aer/commit/f0fcbcb177b9c08467ef070df5e6a03416f70aa2) - The collector no longer records a process started inside a Claude Code tool
  shell (`CLAUDECODE=1` or `CLAUDE_CODE_ENTRYPOINT` set) unless you set
  `AER_RECORD_IN_AGENT_SHELL=1`. Claude Code exports its own environment,
  including any `AER_*` credentials it was given, into every command it runs,
  so a test suite or script an agent started there was recorded into the
  agent's account as a separate short session. The collector now prints one
  line explaining why it did not start.

### Patch Changes

- [`f0fcbcb`](https://github.com/Ad-Astra-Computing/aer/commit/f0fcbcb177b9c08467ef070df5e6a03416f70aa2) - The collector now declares its real version when it opens a session and in
  its closing report. The version was a hand-written number that had fallen
  behind the package, so 0.4.0 reported itself as 0.3.0. It is now read from
  the package at build time.
- [`f0fcbcb`](https://github.com/Ad-Astra-Computing/aer/commit/f0fcbcb177b9c08467ef070df5e6a03416f70aa2) - HTTP requests are now recorded as their host and method only, as the README
  describes. The `http.requested` event used to carry a `path_redacted` field
  that removed the query string but kept the full path, so a token, signed URL
  or object key in a path reached the record. The field is gone. A host value
  that is not a host name (for example one carrying a path or credentials in
  `options.host`) is recorded as `unknown`. The DPoP proof sent to a protected
  resource still binds the full request URL, as the protocol requires; that
  header goes to the resource, never into the record.

  The closing report's `unverifiable` verdict for an adapter whose provider
  was reached through a gateway or a custom base URL now works in a real run.
  It is decided inside the process from the request path, which is judged in
  memory and never recorded.
- [`f0fcbcb`](https://github.com/Ad-Astra-Computing/aer/commit/f0fcbcb177b9c08467ef070df5e6a03416f70aa2) - `spawnSync`, `execSync` and `execFileSync` are now recorded like `spawn`,
  `exec` and `execFile`: a `process.exec` event with the program name and an
  argument count, then a `process.exit` event with the exit code, also when the
  call throws. Previously a subprocess started synchronously, for example
  `execSync('git status')`, left no trace in the record.
- [`f0fcbcb`](https://github.com/Ad-Astra-Computing/aer/commit/f0fcbcb177b9c08467ef070df5e6a03416f70aa2) - The collector now also reads its API key from `AER_TENANT_API_KEY` when
  `AER_API_KEY` is not set, the same fallback `aer doctor`, `aer-emit` and
  `aer-hooks` already accept. Before, a project configured with only
  `AER_TENANT_API_KEY` passed `aer doctor` and then recorded nothing.
  `AER_API_KEY` still wins when both are set.

## 0.4.0

### Minor Changes

- [`5d8c488`](https://github.com/Ad-Astra-Computing/aer/commit/5d8c4884b029fdc66566df9fbd36217e57de1a89) - **Breaking:** the minimum supported Node is now 22, up from 20.

  Node 20 reached end of life on 30 April 2026 and receives no further security
  fixes, so these packages no longer claim to support it. Node 22 is supported
  until 30 April 2027 and remains the floor until then. Node 24 is the current
  long-term support release and is recommended.

  With pnpm, which enforces this field, installing on Node 20 now fails rather
  than warning. With npm it warns.

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

  Three more defects found before publishing are fixed here.

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
