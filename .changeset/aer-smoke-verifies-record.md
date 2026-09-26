---
'@adastracomputing/aer': minor
---

`aer smoke` now checks with the API that its workload produced a completed
session for your agent, and exits 1 when nothing was recorded, instead of
reporting success whenever the workload itself exited 0. It also hands the
collector the same key `aer doctor` checked (`AER_API_KEY`, then
`AER_TENANT_API_KEY`), so a project set up with only `AER_TENANT_API_KEY`
records instead of silently sending nothing, and its workload's subprocess
now shows up in the record. `aer smoke` records even when run from an AI
coding agent's tool shell, since running it is an explicit request to record.
