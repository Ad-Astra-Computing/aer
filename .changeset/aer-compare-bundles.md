---
"@adastracomputing/aer-verify": minor
"@adastracomputing/aer": minor
---

Add `compareBundles` and a new `aer compare <a> <b>` command that checks
whether two signed AER bundles prove the same prompts, the same tool calls
in the same order, and the same observed outcomes, without ever reading
either bundle's plaintext. Both bundles are signature-verified before any
comparison runs. Useful for confirming two sessions, or two runs of the
same agent, actually did the same thing.
