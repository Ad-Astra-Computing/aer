---
'@adastracomputing/aer': minor
---

`aer commitments verify` no longer reports `bundle_signature.anchored: true`
from the bundle's own `integrity.anchored` flag. That flag is outside the
signed hash, so a bundle edited to claim anchoring printed as anchored with
no transparency-log evidence at all. `anchored` is now true only when an
anchor was verified, which this command does not do, and the new
`anchor_status` field shows `claimed` or `none`, the same way `aer verify`
reports it.
