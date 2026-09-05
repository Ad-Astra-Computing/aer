# @adastracomputing/aer-verify

Independent, dependency-free verifier for [AER](https://aer.run) bundles.

An AER (Agent Execution Record) is a signed, canonical record of what an AI agent
did. This package lets anyone check that a bundle is genuine, without trusting the
server that served it and without installing a crypto stack: it recomputes the
canonical hash, verifies the Ed25519 signature and confirms the signing-key-id
binds to the public key. The same reference code runs in Node, Cloudflare Workers
and the browser.

## Install

```
npm install @adastracomputing/aer-verify
```

Zero runtime dependencies. Uses Web Crypto (`crypto.subtle`), available in Node
>= 20, Cloudflare Workers and modern browsers.

## Verify a bundle

```ts
import { verifyAerBundle } from '@adastracomputing/aer-verify';

// `bundle` is the canonical JSON from GET /v1/aers/:id/bundle.
// `publicKeyHex` is the raw Ed25519 key from GET /v1/keys/:id. For true
// origin-independence, pass a pinned key set you obtained out of band.
const result = await verifyAerBundle(bundle, { publicKeyHex });

if (result.ok) {
  console.log('verified', result.aer_id, result.canonical_hash);
} else {
  console.error('NOT verified:', result.reasons);
}
```

### Pin the platform keys

Passing a `pinnedKeys` set is what makes verification independent of the serving
origin: a hostile server cannot substitute a self-consistent bundle+key pair,
because the key must match one you already trust.

```ts
const result = await verifyAerBundle(bundle, {
  pinnedKeys: [{ signing_key_id: '…', public_key_hex: '…', status: 'active' }],
});
result.checks.key_pinned; // true
```

## Result

`verifyAerBundle` returns a `VerifiedAer`:

- `ok`: the policy-evaluated verdict.
- `canonical_hash`: recomputed locally, never echoed from the bundle.
- `checks`: `hash_match`, `signature_valid`, `key_id_binding`, `key_pinned` and
  an `anchor` sub-result.
- `reasons`: stable machine-readable codes (e.g. `hash_mismatch`,
  `signature_invalid`, `key_id_binding_mismatch`, `key_not_pinned`,
  `canonicalize_error`).

`verifyAerBundle` never throws, even on a malformed or attacker-shaped bundle
(unbounded nesting depth, a non-finite number, a bigint, a Date). Any such
shape fails canonicalization and comes back as a normal `ok:false` result with
`canonicalize_error` in `reasons`, rather than an uncaught exception.

## Browsers without native Ed25519

Older Safari lacks Web Crypto Ed25519. Inject a fallback (this package stays
dependency-free):

```ts
import * as ed from '@noble/ed25519';
await verifyAerBundle(bundle, {
  publicKeyHex,
  ed25519Verify: (pub, msg, sig) => ed.verifyAsync(sig, msg, pub),
});
```

## Transparency anchoring

Pass the record's anchor evidence (the Rekor inclusion proof, checkpoint, leaf
body and DSSE envelope served at `GET /v1/aers/:id/anchor-evidence`) together
with a pinned Rekor log key and pinned AER signing keys, and the package
verifies the whole chain offline: Merkle inclusion under the signed checkpoint,
leaf-to-body binding, body-to-envelope binding and the envelope signature over
the locally recomputed canonical hash. The `anchor` check reports one of four
states: `verified` (full chain holds), `claimed` (the bundle asserts anchoring
but no evidence is available), `invalid` (evidence is present and contradicts
the record, which fails the overall verdict) or `none`. A claim is never
trusted without evidence; `builtinTrustRoot()` supplies the pinned production
log key.

## License

Apache-2.0
