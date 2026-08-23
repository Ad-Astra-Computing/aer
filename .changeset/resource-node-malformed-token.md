---
"@adastracomputing/aer-resource-node": patch
---

A token whose signature segment is not valid base64url now fails verification
with the typed AttestationError('malformed') instead of throwing a raw decode
error.
