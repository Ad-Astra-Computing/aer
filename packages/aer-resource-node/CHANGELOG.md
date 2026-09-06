# Changelog

## 0.1.2

### Patch Changes

- [`8ccc1b3`](https://github.com/Ad-Astra-Computing/aer/commit/8ccc1b3fa0bd52983476783c2469e82f5c8fd8d2) - `DEFAULT_JWKS_URL` now points at `api.aer.run`, the canonical AER API host,
  instead of the legacy `aer-api.adastra.computer` hostname. `DEFAULT_ISSUER`
  is unchanged: it is a stable identifier that matches the `iss` claim AER
  mints into every attestation token, not a URL to fetch. The README now
  explains this distinction plainly.
  
  The `hono` and `express` peer dependencies now declare the ranges this
  package is actually tested against (`^4` and `^5`) instead of a bare `*`.

- [`a08ab65`](https://github.com/Ad-Astra-Computing/aer/commit/a08ab65acef0b3bf1edbe731163b7c5bfeb659a2) - A token whose signature segment is not valid base64url now fails verification
  with the typed AttestationError('malformed') instead of throwing a raw decode
  error.

- [`64ac874`](https://github.com/Ad-Astra-Computing/aer/commit/64ac874d765089440cf94a2bb8455fe258e9e2af) - Deny a non-string token with AttestationError('malformed') instead of throwing
  a TypeError, so the reason stays mappable to a status code for a caller using
  verifyAttestation directly. The bundled middleware already guarded this.

## 0.1.1 - 2026-07-20

### Changed

- Packaging only, with no API or behavior change: corrected the repository and
  issues URLs, excluded source maps from the published tarball and added package
  keywords and this changelog.

## 0.1.0 - 2026-07-11

First public release. Verify AER Attestation tokens at a protected resource or MCP
server, offline against a cached JWKS, fail-closed. Ships optional Hono and Express
middleware via the `./hono` and `./express` subpath exports.
