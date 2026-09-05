---
"@adastracomputing/aer-resource-node": patch
---

`DEFAULT_JWKS_URL` now points at `api.aer.run`, the canonical AER API host,
instead of the legacy `aer-api.adastra.computer` hostname. `DEFAULT_ISSUER`
is unchanged: it is a stable identifier that matches the `iss` claim AER
mints into every attestation token, not a URL to fetch. The README now
explains this distinction plainly.

The `hono` and `express` peer dependencies now declare the ranges this
package is actually tested against (`^4` and `^5`) instead of a bare `*`.
