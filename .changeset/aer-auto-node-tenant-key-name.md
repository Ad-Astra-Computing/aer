---
'@adastracomputing/aer-auto-node': patch
---

The collector now also reads its API key from `AER_TENANT_API_KEY` when
`AER_API_KEY` is not set, the same fallback `aer doctor`, `aer-emit` and
`aer-hooks` already accept. Before, a project configured with only
`AER_TENANT_API_KEY` passed `aer doctor` and then recorded nothing.
`AER_API_KEY` still wins when both are set.
