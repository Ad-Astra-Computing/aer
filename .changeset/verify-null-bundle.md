---
"@adastracomputing/aer-verify": patch
---

Return a verdict instead of throwing when the bundle is null, undefined or a
primitive. The never-throw contract did not cover a null bundle, so a caller
passing the result of a failed parse crashed rather than getting ok:false.
