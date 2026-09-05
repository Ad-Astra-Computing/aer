---
"@adastracomputing/aer-emit": patch
---

`resolveSinkOptionsFromEnv` now accepts `AER_TENANT_API_KEY` as a fallback
for `AER_API_KEY`, matching the CLI and the documented behavior of the
opencode plugin. Previously only `AER_API_KEY` was read, so a producer
configured with `AER_TENANT_API_KEY` alone recorded nothing, silently.

README now also states the package is ESM only and lists its Node floor.
