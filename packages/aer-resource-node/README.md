# @adastracomputing/aer-resource-node

Verify **AER Attestation** tokens at a protected resource or MCP server. A
registered agent (running the AER auto-collector) presents a short-lived token;
this library verifies it **offline against cached JWKS, fail-closed**, so
requests without a valid token are denied.

Zero runtime dependencies. The Hono/Express middleware are optional subpath
exports.

ESM only: use `import`, not `require`. Requires Node 20 or newer.

## Install

```
npm install @adastracomputing/aer-resource-node
```

## Verify a token

```ts
import { verifyAttestation, AttestationError } from '@adastracomputing/aer-resource-node';

try {
  const claims = await verifyAttestation(token, { audience: 'mcp://payments-prod' });
  // claims.agent_id / agent_session_id / tenant_id / environment_id …
} catch (e) {
  if (e instanceof AttestationError) { /* deny: e.code */ }
}
```

Defaults: `issuer` defaults to `https://aer-api.adastra.computer`. This is an
identifier, not a URL: it is the exact `iss` string AER mints into every
attestation token, and it stays fixed even though it does not match the
control-plane host. Leave it alone unless AER announces an issuer change.
`jwksUrl` defaults to `https://api.aer.run/.well-known/aer-attestation-jwks.json`,
the canonical AER API host. 30s clock tolerance. JWKS is cached (honoring
`max-age`) and refetched on an unknown `kid`.

## Revocation check (optional introspection)

Offline verify (signature plus short TTL) is the default and needs no network call
past JWKS. To also honor **revocation** within the token's lifetime, pass
`introspect`: after the offline check the verifier asks AER whether the token is
still active (jti not revoked, session still running).

```ts
const claims = await verifyAttestation(token, {
  audience: 'mcp://payments-prod',
  introspect: {
    url: 'https://api.aer.run/v1/attestations/introspect',
    verifierKey: process.env.AER_VERIFIER_KEY!, // aerv_… ; mint via admin
    // activeCacheSec: 10,  // cache an active verdict (default 10s, hard max 30s, never past exp)
    // onUnavailable: 'fail-closed',
  },
});
```

Positive verdicts are cached briefly, so revocation takes effect within
`activeCacheSec` (default 10s). An `inactive` verdict throws
`AttestationError('revoked', reason)`.

> **Availability tradeoff.** `onUnavailable` defaults to **`fail-closed`**: if
> AER's introspection endpoint is unreachable (network error, 5xx, malformed
> body) the token is **denied**, so an AER outage can block your protected
> resource. This is the secure default for admission control. Set
> `onUnavailable: 'fail-open'` to instead accept the already-offline-verified
> (signature-valid, unexpired, ≤5 min old) token during an introspection outage,
> trading a small revocation-latency window for availability.

## Scopes and holder binding (optional)

Beyond audience and signature, `verifyAttestation` can enforce least-privilege
scopes and bind the token to its holder. All of this is optional; pass only what
your resource needs.

```ts
const claims = await verifyAttestation(token, {
  audience: 'mcp://payments-prod',
  requiredScopes: ['payments:write'], // ALL must be present in the token's scp, else insufficient_scope
  // DPoP proof-of-possession (RFC 9449): token must carry cnf.jkt and the
  // request must present a matching proof.
  requireDpop: true,
  dpopProof: req.headers.get('DPoP'),
  method: req.method,
  url: fullRequestUrl,
  // mTLS client-cert binding (RFC 8705 x5t#S256): token must carry cnf["x5t#S256"]
  // and the presented client cert must match.
  requireMtls: true,
  mtlsThumbprint: thumbprintFromPeerCert(tlsSocket),
});
```

Scope enforcement is offline (scopes are signed into the token). DPoP and mTLS
binding are off by default; when enabled, a token that isn't bound, or a request
that fails to prove possession, is denied. `thumbprintFromPeerCert` and
`thumbprintFromForwardedClientCert` compute the `x5t#S256` value from a TLS socket
or a forwarded client-cert header respectively.

The forwarded-cert header must be set by a trusted mTLS-terminating proxy that
strips any inbound client copy first. If a client can set that header it can
spoof the thumbprint and defeat mTLS binding, so never wire
`thumbprintFromForwardedClientCert` to a header a client controls. When you
terminate TLS yourself, use `thumbprintFromPeerCert`: it reads the verified peer
certificate off the socket, which a client cannot forge.

## Middleware (optional)

```ts
import { honoAerAttestation } from '@adastracomputing/aer-resource-node/hono';
app.use('/protected/*', honoAerAttestation({ audience: 'mcp://payments-prod' }));
// claims available at c.get('aerAttestation')
```

```ts
import { expressAerAttestation } from '@adastracomputing/aer-resource-node/express';
app.use('/protected', expressAerAttestation({ audience: 'mcp://payments-prod' }));
// claims available at req.aerAttestation
```

Both read `X-AER-Attestation` (set `allowBearer: true` to also accept
`Authorization: Bearer`), are **fail-closed (403)** by default, and accept
`failOpen: true` to log-and-continue.

## What it proves (and doesn't)

> AER Attestation proves a request was made with a fresh token minted for a
> running AER session and intended audience. It does **not** prove the host is
> uncompromised, or that the collector observed every action.

Token theft on a compromised host is bounded by the short TTL (~5 min), and
further by holder binding when you enable it: a DPoP- or mTLS-bound token is
useless to anyone who lacks the corresponding key or client certificate.

## License

Apache-2.0
