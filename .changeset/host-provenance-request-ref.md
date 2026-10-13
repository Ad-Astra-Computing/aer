---
"@adastracomputing/aer-auto-node": minor
---

Stamp a fresh `request_ref` on every `http.requested`/`http.completed` pair
from the generic fetch and `node:http`/`node:https` patches, so the server
can pair concurrent requests to the same host by call instead of by
host+method+arrival-order alone. When the HTTP call is an LLM provider SDK's
own underlying request, it carries the SAME `request_ref` as that call's
`llm.requested`/`llm.completed` pair, so the two can be joined.
