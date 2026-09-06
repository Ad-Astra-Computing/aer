# Attestation and admission control

Recording what an agent did is useful after the fact. Attestation is the
other half: deciding, at the moment of the request, whether the caller is
an agent you are willing to serve.

## The problem

An MCP server or an internal API cannot tell an instrumented agent from a
script holding the same API key. A static credential says only that
someone knows a secret. It says nothing about whether this particular run
is being recorded.

## The token

A running session can mint a short-lived EdDSA attestation token for a
named audience. The token asserts that a specific agent session, under a
specific tenant, was live and recorded when it was issued.

It carries the scopes granted for that audience, which are the
intersection of what was asked for and what policy allows, so a token can
never widen its own authority.

Verification is offline. Your service fetches the public keys once and
checks signatures locally against a cached copy.

## Proof of possession

A bearer token is only as good as its custody. If it leaks, it works for
whoever holds it. Two optional bindings close that.

DPoP (RFC 9449) binds the token to a per-session key. The token carries
the key's thumbprint, and each request carries a fresh proof signed by
that key. A stolen token without the key is useless.

mTLS binding (RFC 8705) binds the token to the client certificate on the
TLS connection instead.

Both are optional and independent. Ask for what your threat model needs.

## Verifying at your service

```js
import { verifyAttestation } from '@adastracomputing/aer-resource-node';

const claims = await verifyAttestation(token, {
  audience: 'mcp://payments-prod',
  requiredScopes: ['payments:write'],
});
```

Audience is required. A token minted for one service must not be
replayable against another, and checking the audience is what stops that.

Scope checks are offline, because scopes are signed into the token.

Middleware for Hono and Express ships in the same package, and
`@adastracomputing/aer-mcp-guard` puts the same admission check in front
of an HTTP MCP server.

## Fail closed

If the guard cannot decide, it denies. An unreachable key set is a
denial, not a pass. This is deliberate: a component whose failure mode is
"allow everything" provides no security at all, it just moves the outage
somewhere less visible.

Plan for it. Cache keys, and treat a denial storm as the signal it is.

## Revocation

Tokens are short-lived, which limits exposure without any action from
you. For faster response, a token can be revoked by its identifier or a
whole session's tokens revoked at once, and an introspection endpoint
reports current status with revocation applied.

Introspection is a live call, so use it where the stakes justify the round
trip rather than on every request.

## What it does not prove

An attestation token proves there is a live, recorded AER session with
this identity and this intended audience. It does not prove the calling
host is uncompromised, and it does not make the agent trustworthy. It
narrows who can reach your tools to agents that are being recorded, which
is a different and more achievable claim.
