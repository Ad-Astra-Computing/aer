# aer-sdk

Python SDK for [AER](https://aer.run): the flight recorder for AI agents. Emit
events from an agent run and seal them into a signed, independently verifiable
execution record.

Stdlib only, no dependencies. Python 3.10 or newer.

## Install

Not on PyPI, and there is no plan to publish it there. The package is maintained
in this repository and installed from it, so there is one source of truth rather
than a copy that drifts from the code under test. Pin the release tag, which is
what the GitHub release for each version points at. Most current Python
installs refuse a bare `pip install` outside a virtual environment, so make one
first:

```
python3 -m venv .venv
. .venv/bin/activate
pip install "git+https://github.com/Ad-Astra-Computing/aer.git@sdk-py-v0.1.0#subdirectory=packages/sdk-py"
```

Dropping `@sdk-py-v0.1.0` installs whatever is on `main` instead, which can be
ahead of any released version.

With Nix, take it as a flake output rather than a git URL:

```nix
inputs.aer.url = "github:Ad-Astra-Computing/aer";

# then, in your own package set
python3.withPackages (ps: [ aer.packages.${system}.sdk-py ])
```

`nix develop github:Ad-Astra-Computing/aer` gives a shell with Python and the
package's test tooling.

## Use

```python
import os

from aer_sdk import AerClient, create_session

session = create_session(
    base_url="https://api.aer.run",
    tenant_api_key=os.environ["AER_API_KEY"],
    tenant_id="…", agent_id="…", agent_version="1.0.0", environment_id="…",
)

with AerClient(
    base_url="https://api.aer.run",
    session_id=session["agent_session_id"],
    ingest_token=session["ingest_token"],
) as client:
    client.emit("tool.started", {"tool": "web_search"})
    client.emit("tool.completed", {"tool": "web_search", "ok": True})
    client.emit("llm.completed", {"model": "claude-sonnet-4-5", "input_tokens": 812, "output_tokens": 102, "ok": True})

result = client.complete()
print(result["aer_id"], result["canonical_hash"])
```

Events are buffered and posted in batches; a background thread flushes every
500 ms, `complete()` flushes everything and seals the record, and `abort()` is
the crash path (no record is generated). Server errors retry with exponential
backoff; client errors fail fast. Used as a context manager, a clean exit
flushes and closes the client (call `complete()` yourself to seal the record);
an exception aborts the remote session so nothing is left running. A 207
response is transport success with per-event rejections inside; inspect
explicit `flush()` results, or `on_ingest_result`, to observe them.

### `AerClient` options

| Option | Default | Notes |
|---|---|---|
| `base_url` | (required) | Gateway URL. Must be `https://`; `http://` is accepted only for `localhost` or `127.0.0.1`, and anything else raises `ValueError`. |
| `session_id` | (required) | `agent_session_id` returned by `create_session`. |
| `ingest_token` | (required) | Bearer returned by the same call. Keep this secret. |
| `batch_size` | 50 | |
| `flush_interval_ms` | 500 | `0` turns off the background flush thread. |
| `max_retries` | 3 | Applies only to 5xx and network errors. |
| `retry_base_ms` | 100 | Exponential backoff base. |
| `request_timeout_s` | 30.0 | Per-request timeout. |
| `transport` | the built-in transport | Pass a fake for testing. |
| `clock` | `time.time` | For deterministic testing. |
| `on_ingest_result` | none | Called with the result of every events POST, including ones a background flush sent on its own, so a 207 partial accept from a flush the caller did not itself await is not lost. |

## Capture discipline

AER is bodies-off. Emit metadata only: model names, token counts, tool names,
hosts and paths. Never prompts, completions, tool arguments or response bodies.
The server strips unrecognised payload keys at ingest and rejects out-of-bounds
values, so the record can only ever carry bounded, content-free metadata.

## Verify a record

Anyone can verify the result without trusting AER: paste the record id at
[aer.run/verify](https://aer.run/verify), run `aer verify <aer-id>` with the
CLI or use the dependency-free JavaScript verifier
(`@adastracomputing/aer-verify`) against pinned keys.

## Licence

Apache-2.0
