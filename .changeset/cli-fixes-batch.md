---
"@adastracomputing/aer": patch
---

Fix `aer smoke` crashing with ERR_AMBIGUOUS_MODULE_SYNTAX, `aer init --entry`
silently failing to wire an unmatched or valid script, `aer doctor` not
accepting AER_TENANT_API_KEY, raw stack traces on `aer verify`/`aer ingest`
HTTP errors, and `aer commitments verify` accepting a signature from an
unpinned key that `aer verify` would reject.
