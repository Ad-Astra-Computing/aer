# Changelog

## 0.2.0

### Minor Changes

- [`5d8c488`](https://github.com/Ad-Astra-Computing/aer/commit/5d8c4884b029fdc66566df9fbd36217e57de1a89) - **Breaking:** the minimum supported Node is now 22, up from 20.

  Node 20 reached end of life on 30 April 2026 and receives no further security
  fixes, so these packages no longer claim to support it. Node 22 is supported
  until 30 April 2027 and remains the floor until then. Node 24 is the current
  long-term support release and is recommended.

  With pnpm, which enforces this field, installing on Node 20 now fails rather
  than warning. With npm it warns.

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
