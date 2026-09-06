# Changelog

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
