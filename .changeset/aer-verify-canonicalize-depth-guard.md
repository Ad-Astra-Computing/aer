---
"@adastracomputing/aer-verify": patch
---

`verifyAerBundle` no longer throws on a pathological bundle (unbounded
nesting depth, a non-finite number, a bigint or a Date). Canonicalization now
enforces a depth limit and the failure is reported as an ordinary `ok:false`
result with a new `canonicalize_error` reason instead of an uncaught
exception.
