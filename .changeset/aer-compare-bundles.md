---
"@adastracomputing/aer-verify": minor
"@adastracomputing/aer": minor
---

Add `compareBundles` and a new `aer compare <a> <b>` command that checks
whether two signed AER bundles prove the same prompts, responses and tool
arguments and results, the same tool calls in the same order, and the same
observed outcomes (tools used, domains contacted, files touched, processes
spawned), without ever reading either bundle's plaintext. Both bundles are
signature-verified before any comparison runs, and the command only ever
reports a match when every position in both runs was actually checked: a
commitment-key rotation partway through either run is reported instead of
silently passing. Useful for confirming two sessions, or two runs of the
same agent, actually did the same thing.
