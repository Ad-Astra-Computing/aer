---
"@adastracomputing/aer-mcp-guard": minor
---

Security fixes:

- `expressMcpGuard` and `honoMcpGuard` now throw at setup if `requireDpop` is
  set without `trustedOrigin` (new option on Hono's adapter, matching
  Express's). Without it, the DPoP `htu` origin was derived from the
  client-controlled `Host` header, letting an attacker holding a captured
  proof replay it across deployments sharing the same audience and replay
  store by spoofing `Host`. Pin `trustedOrigin` to your resource's real
  public origin. This is a breaking change for any caller relying on the old
  fallback.
- A `resolveMtlsThumbprint` resolver that throws now denies the request (401)
  instead of raising an unhandled rejection that could crash the process.
- Express's internal async handler now forwards an unexpected rejection to
  `next` instead of swallowing it.
- README: stronger warnings on `thumbprintFromForwardedClientCert` (only safe
  behind a proxy that strips and overwrites the header before your app sees
  it), on `trustedOrigin`, and a note that the framework-neutral core has no
  setup-time check of its own.
