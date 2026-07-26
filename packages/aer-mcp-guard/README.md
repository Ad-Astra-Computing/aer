# @adastracomputing/aer-mcp-guard

Admission control for **HTTP MCP servers**. Only agents carrying a valid
[AER Attestation](https://aer.run) token reach your tools; an unattested client
(one that doesn't run the AER collector, so has no token) is denied with a
JSON-RPC 2.0 error.

Built on [`@adastracomputing/aer-resource-node`](https://www.npmjs.com/package/@adastracomputing/aer-resource-node)
(offline verify against cached JWKS, optional revocation introspection). No
dependency on `@modelcontextprotocol/sdk`: mount it in front of any MCP HTTP
endpoint.

> **Scope:** HTTP MCP transports only, meaning Streamable HTTP and SSE. `stdio` MCP
> runs locally with no network admission point, so it is out of scope. This package
> gates the **whole transport**: every MCP HTTP request must carry a valid
> attestation (clients that can't attach headers during `initialize` aren't
> supported).

## Install

```
npm install @adastracomputing/aer-mcp-guard
```

Requires Node 20 or newer.

## Hono

```ts
import { honoMcpGuard } from '@adastracomputing/aer-mcp-guard/hono';

app.use('/mcp', honoMcpGuard({ audience: 'mcp://payments-prod' }));
// claims available at c.get('aerAttestation'); mount your MCP handler after.
```

## Express

```ts
import { expressMcpGuard } from '@adastracomputing/aer-mcp-guard/express';

app.use('/mcp', expressMcpGuard({ audience: 'mcp://payments-prod' }));
// claims attached at req.aerAttestation
```

## Framework-neutral core

```ts
import { guardMcpRequest } from '@adastracomputing/aer-mcp-guard';

const result = await guardMcpRequest((name) => req.headers.get(name), {
  audience: 'mcp://payments-prod',
});
if (!result.ok) {
  // result.status (401/403/503) + result.jsonRpcError, send as-is
  return new Response(JSON.stringify(result.jsonRpcError), { status: result.status });
}
// result.claims.agent_id / agent_session_id / tenant_id …
```

## Revocation (optional)

Pass `introspect` to also honor revocation within the token's lifetime (see
`@adastracomputing/aer-resource-node`). The guard caches positive verdicts briefly and is
**fail-closed** by default if introspection is unreachable.

```ts
honoMcpGuard({
  audience: 'mcp://payments-prod',
  introspect: {
    url: 'https://api.aer.run/v1/attestations/introspect',
    verifierKey: process.env.AER_VERIFIER_KEY!, // aerv_… ; mint via admin
  },
});
```

## Deny contract

On denial the guard returns an HTTP status plus a JSON-RPC 2.0 error
(`code: -32001`, `message: "attestation required"`, `data.reason`):

| status | when |
| --- | --- |
| **401** | no token / malformed / bad signature / expired / wrong audience or issuer |
| **403** | token valid but revoked (introspection reports inactive) |
| **503** | introspection unreachable and fail-closed (token liveness unknown) |

The request **body is never consumed**, so SSE and streaming Streamable-HTTP
requests pass through untouched. The JSON-RPC `id` is echoed only when your
framework already parsed the body (Express `req.body`); otherwise it is `null`.

## Holder binding (optional)

`GuardOptions` extends the verifier's options, so everything
`@adastracomputing/aer-resource-node` supports is available here: `requiredScopes`
for least-privilege, plus DPoP (`requireDpop`) and mTLS (`requireMtls`) holder
binding. When you enable DPoP the guard reads the `DPoP` header for you; for mTLS
you resolve the client-cert thumbprint from your handler and pass it via
`resolveMtlsThumbprint`. A bound token that arrives without a valid proof is
denied with a `401` DPoP challenge.

Resolve the thumbprint from your TLS terminator (a verified peer cert, or a
forwarded header your trusted proxy sets and strips from client input), never
from a header a client can set.

Note that `audience` binds a token to the resource, so a resource that serves
more than one AER tenant should also check `claims.tenant_id` (available on the
returned claims) if it needs per-tenant authorization, since a valid token for
the same audience from any tenant will otherwise pass.

## What it proves

That the request was made with a fresh token minted for a running AER session and
intended for this audience. It does **not** prove the agent host is uncompromised.
The short TTL plus optional introspection bound replay, and DPoP or mTLS binding
(when enabled) ties the token to a specific holder.

## License

Apache-2.0
