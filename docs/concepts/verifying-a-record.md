# Verifying a record

Verification is the part that needs nothing from us. Given a bundle,
`@adastracomputing/aer-verify` decides whether it is genuine on your
machine, with no network calls and no account.

```sh
npx @adastracomputing/aer verify <aer-id>
```

The command fetches the bundle and the public key first, then does all of
the checking locally. If you already hold a bundle, the library alone is
enough.

## The checks

`hash_match` recomputes the canonical hash of the content and compares it
to the one in the bundle. Canonicalization is deterministic, so the same
record always produces the same bytes and the same hash.

`signature_valid` checks the Ed25519 signature over that hash.

`key_id_binding` checks that the key identifier in the bundle is actually
derived from the public key presented, so a bundle cannot claim one key
and be verified with another.

`key_pinned` checks that the key is in the trusted set and was inside its
validity window at signing time. A key that has since been retired still
verifies records it signed while it was live, which is what you want:
rotation must not invalidate history.

`anchor` evaluates the transparency-log evidence, below.

## The four anchor states

Anchoring publishes a record's identity to the Sigstore Rekor transparency
log, so its existence at a point in time can be corroborated by a third
party. The result is four-state rather than a boolean, because "we have no
evidence" and "the evidence contradicts the bundle" are very different
situations and collapsing them loses the distinction that matters.

**`verified`** means inclusion in the log was checked and holds.

**`none`** means the bundle makes no anchoring claim. Nothing is wrong.
Anchoring is optional and a tenant can turn it off.

**`claimed`** means the bundle says it was anchored and the supporting
evidence is not available to check right now. This does not downgrade the
verdict. The signature is what makes a record genuine, and anchoring adds
corroboration on top.

**`invalid`** means evidence is present and contradicts the bundle. This
is the only anchor state that makes the overall verdict fail, and it
should be treated as a serious signal rather than a warning.

## Offline by design

The verifier ships the trust root it needs and makes no requests. That is
a deliberate constraint rather than an implementation detail, and it is
why the package has no dependencies: a verifier you cannot audit is not
much of a verifier.

The practical consequence is that a record outlives its issuer. If AER
disappeared tomorrow, every record already produced would still verify
with a copy of the library and the bundle.

## Reason codes

A failed verification returns machine-readable reason codes rather than a
message to parse, so you can gate on a specific failure in CI. A hostile
or malformed bundle returns a verdict too. The verifier never throws.
