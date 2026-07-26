# @adastracomputing/aer-auto-node

Auto-instrumentation for Node agents. Drop it in and AER records what your
agent is actually doing (network calls, LLM turns, tool/function calls, processes,
dependencies) with **zero manual `emit()`**. Events stream to AER live while the
agent runs; completion seals them into a signed record.

What you get: a `register` bootstrap that patches `fetch`, `node:http(s)` and
`node:child_process`; semantic adapters for OpenAI, Anthropic and the Vercel AI
SDK; a dependency snapshot and a signed coverage report; and three session
strategies (`process`, `task`, `server`) plus `withAerSession` for explicit
scoping. The fastest way in is the `register` hook shown below.

## Use

```bash
node --import @adastracomputing/aer-auto-node/register your-agent.js
# or
NODE_OPTIONS="--import @adastracomputing/aer-auto-node/register" your-start-command
```

Configuration: non-secret identity lives in `aer.config.json`; the only secret,
`AER_API_KEY`, comes from the environment.

```jsonc
// aer.config.json
{
  "schema": "aer.config.v1",
  "tenant_id": "…",
  "agent_id": "…",
  "env_id": "…",
  "base_url": "https://api.aer.run"
}
```

```bash
export AER_API_KEY=…          # the only secret env var
# optional CI overrides: AER_TENANT_ID / AER_AGENT_ID / AER_ENV_ID / AER_BASE_URL
```

## Principal (who the run is for)

Attach the identity a run acts on behalf of, so a record answers "which user or
service did this". It is optional and signed into the record, so keep the id
opaque (an IdP subject or employee id, never an email).

```bash
export AER_PRINCIPAL_ID=emp-77        # opaque, required to set a principal
export AER_PRINCIPAL_KIND=user        # user | service | ci (defaults to user)
export AER_PRINCIPAL_DISPLAY="Grace H." # optional short label for feeds
```

You can also set `principal` in `aer.config.json`, or pass one per task to
`withAerSession({ principal: { id, kind, display } })`, which overrides the
process-wide value for that session only.

## Content commitments (optional)

When you set a commitment key, the collector commits to the LLM request and
response it observes at the trust boundary and signs those commitments into the
record. Each commitment is a one-way HMAC tag computed under your key: AER holds
neither the key nor the plaintext, so it can neither open nor brute-force a tag.
Later you can prove offline, from your key and your retained plaintext, that a
given prompt or response is exactly what the signed record committed to.

```bash
export AER_COMMITMENT_KEY=…    # >=32 bytes; a 64-hex string is the recommended form
```

Provide the key as 64 hex characters (recommended), or base64 / base64url of at
least 32 bytes. Prefer 64-hex to avoid any ambiguity: a base64 string that
happens to be all hex characters with an even length is read as hex. Without a
key the collector emits no commitments; there is deliberately no bare-hash
fallback, which would be a low-entropy oracle.

The tags cover the canonicalized request (`prompt_canon_tag`, so the same logical
prompt to OpenAI or Anthropic yields the same tag), the assembled response text
(`response_tag`, streaming or not), the full canonicalized request body including
sampling parameters (`wire_canon_tag`) and each tool call's arguments and the
tool results fed back in (`tool_args_tag` / `tool_result_tags`). Every tag carries
a non-secret `kid` identifying which key produced it, so keys can rotate. The
`./commitment` subpath export exposes the canonicalization and tagging primitives
for independent verification. The whole path is best-effort and fail-open: a fault
degrades to a name-only event and never breaks the host SDK call.

## Safety

- **Kill switch**: `AER_DISABLE=1` installs nothing. No patches, no session, no
  config reads beyond env.
- **Never throws into the host**: capture failures are swallowed and counted.
- **Lazy**: the session opens on the first captured event, never for a plain
  script that does nothing instrumentable.
- **Metadata-only defaults**: no request/response bodies, no headers; URLs are
  reduced to their host and process commands to the executable name.

## Semantic LLM/tool capture

SDK adapters (enabled automatically when the SDK is detected) emit `llm.requested`,
`llm.completed` and `tool.selected` from **structured metadata only**: model,
token usage, stop/finish reason and tool **names**. Never prompts, model text, or
tool arguments.

- **OpenAI** (`openai`): `chat.completions.create`
- **Anthropic** (`@anthropic-ai/sdk`): `messages.create`
- **Vercel AI SDK** (`ai`): `generateText` / `streamText` / `generateObject` /
  `streamObject`. Streaming usage is read from the result's `usage`,
  `finishReason` and `toolCalls` promises (see below).

All three providers are covered for non-streaming calls, streaming token counts
and streaming tool names. The capture mechanism differs by provider:

| Provider | Mechanism |
|----------|-----------|
| OpenAI (`openai`) | in-band chunk tap (`stream_options.include_usage` for tokens) |
| Anthropic (`@anthropic-ai/sdk`) | in-band chunk tap (message-stream events) |
| Vercel AI SDK (`ai`) | result `usage` / `finishReason` / `toolCalls` promises |

Every field captured is metadata: model, token counts, finish/stop reason and tool
**names**. Prompts, generated text, content deltas, tool arguments and request
bodies are never captured, on any provider, streaming or not.

### Streaming

For **OpenAI** and **Anthropic** streaming calls the adapter taps the response
stream **in place**: it shadows the stream's async iterator, so as your code
drains it we fold each chunk's structured metadata (token usage, finish/stop
reason, tool **names**) and emit `llm.completed` when the stream ends. It never
reads chunk text, content deltas or tool arguments. The completion carries
`streaming: true`, `duration_ms` and `usage_observed` (`false` when the provider
sent no token usage, for example OpenAI without `stream_options.include_usage`;
`stop_reason` and tool names may still be present). The tap never pulls ahead of
your code, never changes backpressure and preserves the stream object's identity
and methods. A stream you never consume yields only `llm.requested`.

The **Vercel AI SDK** exposes streaming usage differently: not as in-band chunks
but as result promises (`usage`, `finishReason`, `toolCalls`). For `streamText` /
`streamObject` the adapter attaches non-invasive observers to those promises and
emits `llm.completed` once they settle, without ever reading `textStream` /
`fullStream` content. Each promise settles independently, so one rejected or
missing promise never loses the others.

The **final `collector.report`** carries an `adapter_activity` summary so you can
see SDK-level activity at a glance without scanning the event firehose. It is
keyed by provider and only lists adapters that actually ran:

```json
"adapter_activity": {
  "openai":    { "calls": 42, "ok": 41, "error": 1, "tool_selections": 7 },
  "anthropic": { "calls": 5,  "ok": 5,  "error": 0, "tool_selections": 2 }
}
```

`calls` counts recognized SDK calls, `ok` / `error` count completions by outcome
and `tool_selections` counts tool calls observed in responses. Counts are
metadata only.

## Known limitation

Patch-based capture observes **`globalThis.fetch`** (the common case) and
**default-import property access** for `node:http(s)` / `node:child_process`
(`import cp from 'node:child_process'; cp.spawn(...)`). A **named import**
(`import { spawn } from 'node:child_process'` or `import { generateText } from 'ai'`)
binds to the original function before the patch applies and is not captured; use
default-import property access (`cp.spawn(...)`) or `globalThis.fetch` so the
patched function is resolved at call time.

## Session strategies

Set `session.strategy` in `aer.config.json`:

- **`process`** (default): one process is one session. Opens on the first captured
  event, completes on clean exit. Right for CLI and one-shot agents.
- **`task`**: a fresh session per `withAerSession(...)` task. Activity outside a
  task falls back to a process session (or is dropped with
  `session.requireTask: true`).
- **`server`**: long-running apps get **no implicit session**. Wrap each agent run
  in `withAerSession(...)`; anything outside is not recorded.

```ts
import { withAerSession } from '@adastracomputing/aer-auto-node';

app.post('/run', async (req, res) => {
  const result = await withAerSession({ agentId: 'support-bot' }, async () => {
    return runAgent(req.body);   // all fetch/LLM/tool/process activity in here
  });                            // is captured into ONE session, completed on return
  res.json(result);
});
```

## Attestation injection (admission control)

For a protected resource that only admits AER-registered agents, list
it under `protected_resources`. The collector then attaches a short-lived
`X-AER-Attestation` token (minted for the running session + that audience) to
matching outbound requests. An agent that doesn't run the collector sends no
token and is denied by the resource's verifier (`@adastracomputing/aer-resource-node`).

```jsonc
// aer.config.json
{
  "protected_resources": [
    { "host": "mcp.internal", "audience": "mcp://internal-tools" },
    { "host": ".corp.example", "audience": "https://corp.example" } // leading dot = subdomain suffix
  ]
}
```

- **HTTPS only.** Tokens are never injected over plain `http://`, and never to a
  host that isn't listed (third-party LLM APIs are untouched unless you add them).
- **Never overwrites** a caller-supplied `X-AER-Attestation` header.
- **No cross-origin leak.** A bearer-style header must not follow a redirect to a
  different origin. On an injected `fetch`, redirects are followed by the
  collector: the token is re-attached only when the next hop maps to the **same
  audience**, and stripped otherwise (capped at 20 hops; `redirect: 'manual'`/
  `'error'` are respected). The `host(s)` patch never follows redirects.
- **`fetch`** is fully covered: the patched call awaits the token before sending.
- **`node:http(s)`** is synchronous and can't await, so it injects a **cached**
  token and warms the cache in the background. The very first request to a
  protected host on a cold cache may go without a token (fail-closed, retry
  succeeds); the collector prewarms the cache at startup for the `process`
  strategy to avoid this. `fetch` has no such window.
- Coverage counters (`injected` / `cache_miss` / `warm_failed` /
  `redirect_cross_origin_stripped` / `redirect_manual_fallback`) ride in the
  final `collector.report`, useful when a redirected resource intermittently
  rejects attestation.

`withAerSession` uses `AsyncLocalStorage`, so concurrent requests get isolated
sessions across `await`s. It completes the session when the body resolves and
aborts it if the body throws.

## Usage policies

When an operator has set a usage policy for the agent (via the control plane), the
collector fetches it once at session open and enforces it against every LLM call.
A policy can allow or deny models by glob (`gpt-*`, `*-vision`) and cap the calls
and tokens per session. It runs in one of three modes:

- **off**: no enforcement.
- **report**: the collector emits a `policy.violation` event and lets the call
  proceed. Use this to measure what a policy would catch before you turn it on.
- **block**: the collector throws `AerPolicyError` before the SDK call happens, so
  the offending call is never sent. Your own `try/catch` around the LLM call sees
  it. Token budgets are the one exception: tokens are known only after a response,
  so a token overage is always reported after the fact and never retroactively
  thrown.

When a policy is in effect the collector records one `policy.applied` event so the
signed record shows which policy governed the run, and a `policy.violation` event
per breach. Policy events carry the model name and counts only, never prompts or
content, consistent with the metadata-only rule.

The fetch is best-effort and time-bound. It never blocks or breaks session open.
If the policy endpoint is unreachable or returns nothing, enforcement is simply
off for that session (fail-open): this is a cost control, not a security boundary,
and a fetch you could not complete has no mode to honor.

```ts
import { AerPolicyError } from '@adastracomputing/aer-auto-node';

try {
  await client.chat.completions.create({ model: 'gpt-4o', messages });
} catch (err) {
  if (err instanceof AerPolicyError) {
    // blocked by usage policy: err.rule, err.model, err.limit, err.observed
  } else {
    throw err;
  }
}
```

**Limits of enforcement.** This enforcement is best-effort and bypassable by anyone who
removes the collector. It stops runaway and misconfigured agents, not a hostile
operator. The strong path is attestation scopes at a protected LLM gateway (see
<em>Attestation injection</em> above), where the model access is gated by a signed
token the resource verifies, not by client-side code the caller controls.

## Programmatic API (advanced)

```ts
import { captureEvent, getActiveSession } from '@adastracomputing/aer-auto-node';

// Manual escape hatch for things the auto-capture can't see:
captureEvent({ event_type: 'tool.completed', payload: { tool: 'my_tool', ok: true } });
```

Auto-capture is the norm; reach for `captureEvent` only as an escape hatch.
