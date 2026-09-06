# Changelog

## 0.1.2

### Patch Changes

- [`838eb73`](https://github.com/Ad-Astra-Computing/aer/commit/838eb73d253e836ee9b1f335451541d99ac75380) Thanks [@jasonodoom](https://github.com/jasonodoom)! - `DEFAULT_JWKS_URL` now points at `api.aer.run`, the canonical AER API host,
  instead of the legacy `aer-api.adastra.computer` hostname. `DEFAULT_ISSUER`
  is unchanged: it is a stable identifier that matches the `iss` claim AER
  mints into every attestation token, not a URL to fetch. The README now
  explains this distinction plainly.
  
  The `hono` and `express` peer dependencies now declare the ranges this
  package is actually tested against (`^4` and `^5`) instead of a bare `*`.

- [`e3e013b`](https://github.com/Ad-Astra-Computing/aer/commit/e3e013be8617e9746ab43d4de572c38272392b54) Thanks [@jasonodoom](https://github.com/jasonodoom)! - A token whose signature segment is not valid base64url now fails verification
  with the typed AttestationError('malformed') instead of throwing a raw decode
  error.

## 0.1.1 - 2026-07-20

### Changed

- Packaging only, with no API or behavior change: corrected the repository and
  issues URLs, excluded source maps from the published tarball and added package
  keywords and this changelog.

## 0.1.0 - 2026-07-11

First public release. Verify AER Attestation tokens at a protected resource or MCP
server, offline against a cached JWKS, fail-closed. Ships optional Hono and Express
middleware via the `./hono` and `./express` subpath exports.
