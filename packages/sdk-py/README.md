# aer-sdk

Python SDK for [AER](https://aer.run), the flight recorder for AI agents. Emit
events from an agent run and seal them into a signed, independently verifiable
execution record.

Stdlib only, no dependencies. Python 3.10 or newer.

## Install

Not on PyPI, and there is no plan to publish it there. The package is maintained
in this repository and installed from it, so there is one source of truth rather
than a copy that drifts from the code under test.

```
pip install "git+https://github.com/Ad-Astra-Computing/aer.git#subdirectory=packages/sdk-py"
```

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
explicit `flush()` results to observe them.

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
