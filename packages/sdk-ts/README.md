# @adastracomputing/aer-sdk-ts

Event-emission helper for apps and agents that want to send events to an AER gateway.

ESM only: use `import`, not `require`. Requires Node 20 or newer.

## Install

```
npm install @adastracomputing/aer-sdk-ts
```

For zero-code capture, use `@adastracomputing/aer-auto-node` instead; this SDK
is for explicit, app-controlled emission.

## Usage

```ts
import { createAerClient } from '@adastracomputing/aer-sdk-ts';

// 1. Open a session against the hosted AER gateway (or your own base URL).
const res = await fetch('https://api.aer.run/v1/sessions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    tenant_id, agent_id, agent_version: '1.0.0', environment_id,
  }),
});
const { agent_session_id, ingest_token } = await res.json();

// 2. Emit events.
const client = createAerClient({
  baseUrl: 'https://api.aer.run',
  sessionId: agent_session_id,
  ingestToken: ingest_token,
});

await client.emit('session.started', { agent: 'my-agent' });
await client.emit('tool.started', { tool: 'lookup' });
await client.emit('tool.completed', { tool: 'lookup', ok: true });
await client.emit('session.ended', { status: 'completed' });

// 3. Finalize: flushes, then POST /complete.
await client.complete();
await client.close();
```

## Behavior

- **Auto-populates** `event_id` (UUIDv7), `timestamp_observed` (UTC ms), `source_type: 'sdk'` and `severity_hint: 'info'` on every emission.
- **Batches** up to `batchSize` (default 50) events before POSTing.
- **Periodic flush** on `flushIntervalMs` (default 500 ms). The interval timer is `unref`'d, so it will not keep a Node process alive.
- **Backoff+retry** on 5xx up to `maxRetries` (default 3). 4xx is surfaced immediately; there is no point retrying a validation error.
- **Failure handling** on flush: failed chunk is pushed back to the front of the queue so `close()` or the next flush can try again.
- **`close()`** drains the buffer before returning. Nothing is dropped on shutdown (as long as `close()` completes).

## Options

| Option | Default | Notes |
|---|---|---|
| `baseUrl` | (required) | Gateway URL, no trailing slash required. |
| `sessionId` | (required) | `agent_session_id` returned by `POST /v1/sessions`. |
| `ingestToken` | (required) | Bearer returned by the same call. Keep this secret. |
| `batchSize` | 50 | |
| `flushIntervalMs` | 500 | |
| `maxRetries` | 3 | Applies only to 5xx/network errors. |
| `retryBaseMs` | 100 | Exponential backoff base. |
| `fetchImpl` | global `fetch` | Pass a mock for testing. |
| `clock` | `() => new Date()` | For deterministic testing. |

## Why emit from the app at all?

AER's value is the *correlation* of app-level semantic context with observed
behavior. App-level traces carry what the agent thought it was doing (tool
selected, LLM call, decision). Transport-level capture carries what observably
happened (network calls, processes, writes). The AER fuses both. Skipping app
emission leaves semantic intent missing, so detections get harder and
explanations get worse.

## License

Apache-2.0
