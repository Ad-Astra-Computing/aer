---
"@adastracomputing/aer-hooks": patch
"@adastracomputing/aer": patch
---

Fix three gaps in the model-to-vendor mapping used for usage-metadata
events: a bare `codex` model name with no codename resolved to
`undefined`, one provider's harness/vendor relationship comment was lost
in an earlier trim, and a new codename from the live model picker needed
the same bare-form fallback an earlier one already had.
