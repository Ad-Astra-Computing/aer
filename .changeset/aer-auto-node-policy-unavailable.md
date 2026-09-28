---
'@adastracomputing/aer-auto-node': minor
---

The collector now tells an agent with no usage policy (404) apart from a
policy it could not fetch. A failed fetch is retried after 30 seconds instead
of being treated as "no policy". When a refresh fails, the last policy fetched
keeps governing new sessions; once it is more than 5 minutes old and the
latest refresh has failed, a block-mode policy that says
`on_unavailable: fail_closed` refuses every LLM call in new sessions with
rule `policy_unavailable`. When the first fetch fails and no policy was ever
fetched, sessions run ungoverned until a fetch succeeds.
