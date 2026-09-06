# Changelog

## 0.1.2

### Patch Changes

- [`838eb73`](https://github.com/Ad-Astra-Computing/aer/commit/838eb73d253e836ee9b1f335451541d99ac75380) Thanks [@jasonodoom](https://github.com/jasonodoom)! - `hono` and `express` peer dependencies now declare the ranges this package
  is actually tested against (`^4` and `^5`) instead of a bare `*`. The README
  also now explains that the default `issuer` and `jwksUrl` come from
  `@adastracomputing/aer-resource-node`.
- Updated dependencies [[`838eb73`](https://github.com/Ad-Astra-Computing/aer/commit/838eb73d253e836ee9b1f335451541d99ac75380), [`e3e013b`](https://github.com/Ad-Astra-Computing/aer/commit/e3e013be8617e9746ab43d4de572c38272392b54)]:
  - @adastracomputing/aer-resource-node@0.1.2

## 0.1.1 - 2026-07-20

### Changed

- Packaging only, with no API or behavior change: corrected the repository and
  issues URLs, excluded source maps from the published tarball and added package
  keywords and this changelog.

## 0.1.0 - 2026-07-11

First public release. Admission control for HTTP MCP servers: only AER-attested
agents reach your tools, and an unattested client gets a JSON-RPC deny. Ships optional Hono
and Express middleware via the `./hono` and `./express` subpath exports.
