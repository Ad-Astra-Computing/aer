# Changelog

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
