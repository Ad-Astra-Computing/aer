---
'@adastracomputing/aer-mcp-guard': minor
---

When the attestation JWKS cannot be fetched, the guard now denies with HTTP
503 and reason `jwks_unavailable`, the same way an unreachable introspection
endpoint is reported, instead of 401 `unknown_kid`. The request is still
denied; the new status tells the caller the guard could not decide and a
retry may succeed, rather than that the token was bad. A token is also no
longer admitted from an expired JWKS cache during an outage.
