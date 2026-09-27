---
'@adastracomputing/aer-resource-node': minor
---

Token verification now fails closed when the JWKS cannot be fetched. An
expired JWKS cache used to be reused when the refetch failed, so a token
could still be accepted during a JWKS outage; it is now denied. A JWKS outage
(a network error, a non-2xx answer or a body that is not a JWKS) is reported as
the new reason `jwks_unavailable` instead of `unknown_kid`, which now only
means the JWKS was read and does not publish the token's key.
