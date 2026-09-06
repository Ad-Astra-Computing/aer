# Changelog

## 0.1.2

### Patch Changes

- [`8ccc1b3`](https://github.com/Ad-Astra-Computing/aer/commit/8ccc1b3fa0bd52983476783c2469e82f5c8fd8d2) - `hono` and `express` peer dependencies now declare the ranges this package
  is actually tested against (`^4` and `^5`) instead of a bare `*`. The README
  also now explains that the default `issuer` and `jwksUrl` come from
  `@adastracomputing/aer-resource-node`.
- Updated dependencies [[`8ccc1b3`](https://github.com/Ad-Astra-Computing/aer/commit/8ccc1b3fa0bd52983476783c2469e82f5c8fd8d2), [`a08ab65`](https://github.com/Ad-Astra-Computing/aer/commit/a08ab65acef0b3bf1edbe731163b7c5bfeb659a2), [`64ac874`](https://github.com/Ad-Astra-Computing/aer/commit/64ac874d765089440cf94a2bb8455fe258e9e2af)]:
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
