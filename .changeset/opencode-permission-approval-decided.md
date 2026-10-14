---
"@adastracomputing/aer-hooks": patch
---

Record opencode's `permission.asked`/`permission.replied` bus events as `approval.decided`, closing the one harness with no oversight-marker coverage. Reads both the pinned SDK type declarations' field names and the ones actually observed on a live run of the current opencode-ai binary, which disagree with those declarations.
