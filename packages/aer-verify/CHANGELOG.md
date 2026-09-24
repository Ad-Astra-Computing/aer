# Changelog

## 0.2.0

### Minor Changes

- [`5d8c488`](https://github.com/Ad-Astra-Computing/aer/commit/5d8c4884b029fdc66566df9fbd36217e57de1a89) - **Breaking:** the minimum supported Node is now 22, up from 20.

  Node 20 reached end of life on 30 April 2026 and receives no further security
  fixes, so these packages no longer claim to support it. Node 22 is supported
  until 30 April 2027 and remains the floor until then. Node 24 is the current
  long-term support release and is recommended.

  With pnpm, which enforces this field, installing on Node 20 now fails rather
  than warning. With npm it warns.

## 0.1.2

### Patch Changes

- [`e1b4203`](https://github.com/Ad-Astra-Computing/aer/commit/e1b420391da787697228d48010ab6c87302a5551) - The bundle `correlation.sources` field parses a bounded string rather than a fixed enum, so a record sealed with a source type newer than a reader's schema still parses. Event ingest keeps the strict enum, where both ends are controlled. This matches the server and retires a rollout hazard when a new source type is added.

## 0.1.1

### Patch Changes

- [`fb6261b`](https://github.com/Ad-Astra-Computing/aer/commit/fb6261bbfea2374bbce6e982101180b094fb0adf) - `verifyAerBundle` no longer throws on a pathological bundle (unbounded
  nesting depth, a non-finite number, a bigint or a Date). Canonicalization now
  enforces a depth limit and the failure is reported as an ordinary `ok:false`
  result with a new `canonicalize_error` reason instead of an uncaught
  exception.

- [`ac60049`](https://github.com/Ad-Astra-Computing/aer/commit/ac60049c238131c103e00a6e4f9ce4d693c10df3) - Return a verdict instead of throwing when the bundle is null, undefined or a
  primitive. The never-throw contract did not cover a null bundle, so a caller
  passing the result of a failed parse crashed rather than getting ok:false.

## 0.1.0 - 2026-07-20

Initial release. Dependency-free AER bundle verifier that runs in any Web Crypto
runtime (Node >= 20, Cloudflare Workers, modern browsers).

### Added

- `verifyAerBundle`: recompute the canonical hash, verify the Ed25519 signature
  over the hash bytes and assert the signing-key-id binds to the public key.
  Optional pinned key set makes verification independent of any served key.
- Offline transparency-anchor verification: given anchor evidence (Rekor
  inclusion proof, signed checkpoint, leaf body, DSSE envelope) and pinned log
  and signing keys, verify the full chain locally and report a four-state
  `anchor` result (`verified`, `claimed`, `invalid`, `none`). A claimed anchor
  without evidence is never trusted. `builtinTrustRoot()` ships the pinned
  production log key.
- `canonicalize` / `canonicalHash`: a `node:crypto`-free port of `json-c14n-v1`,
  golden-tested for byte-parity with the server implementation.
- DSSE primitives (`paeBytes`, `verifyDsseEnvelope`, `decodeAttestation`) and key
  helpers (`signingKeyIdFromPublicKey`, `subtleEd25519Verify`) with an injectable
  Ed25519 verify seam for runtimes without native support.
