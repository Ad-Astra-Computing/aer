---
"@adastracomputing/aer-mcp-guard": patch
---

`hono` and `express` peer dependencies now declare the ranges this package
is actually tested against (`^4` and `^5`) instead of a bare `*`. The README
also now explains that the default `issuer` and `jwksUrl` come from
`@adastracomputing/aer-resource-node`.
