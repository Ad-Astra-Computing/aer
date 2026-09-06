---
"@adastracomputing/aer-resource-node": patch
---

Deny a non-string token with AttestationError('malformed') instead of throwing
a TypeError, so the reason stays mappable to a status code for a caller using
verifyAttestation directly. The bundled middleware already guarded this.
