---
"@adastracomputing/aer-resource-node": patch
---

Fix two issues in the Hono and Express middleware helpers and in the token
introspection cache.

The Hono and Express middleware helpers now check a DPoP proof against the
real method and URL of each incoming request. Previously, turning on DPoP
proof-of-possession checking through either helper either rejected every
request or, worse, checked the proof against a value that had nothing to do
with the actual request, because the method and URL were only ever read once
when the middleware was set up, not per request. Anyone relying on DPoP
through `honoAerAttestation` or `expressAerAttestation` (rather than calling
`verifyAttestation` directly and wiring these values themselves) should
upgrade. Enabling DPoP through either helper now requires pinning a
`trustedOrigin` option, since the `Host` header a server sees is set by the
client and cannot safely be trusted to build that URL on its own.

Turning on mutual-TLS client-certificate binding (`requireMtls`) through
either middleware helper now throws immediately when you set it up, rather
than silently comparing every request against a fixed certificate
thumbprint: a generic middleware has no way to read the certificate a given
request actually presented, so call `verifyAttestation` directly for that.

The token introspection cache also no longer grows without bound. It kept one
entry per distinct token it had ever checked and only dropped an entry when
that same token was looked up again, so a resource server that ran for a long
time and saw many different tokens accumulated memory indefinitely. It now
periodically clears out expired entries and, if that is not enough, drops the
ones expiring soonest, so memory use stays bounded no matter how many tokens
pass through it. Entries are also now keyed by a hash of the token rather
than the token itself, so a live, usable credential no longer sits around in
that cache's memory.
