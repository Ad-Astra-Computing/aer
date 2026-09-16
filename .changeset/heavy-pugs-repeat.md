---
"@adastracomputing/aer": patch
---

Generate an environment id during `aer init` and accept either name for the tenant key.

Nothing issues an environment id and nothing registers it, so `REPLACE_WITH_ENV_ID` left the reader with a value they had no way to look up. `aer init` now writes one.

`sessions`, `agents`, `findings`, `audit`, `aers`, `baseline`, `webhooks` and `import` read only `AER_TENANT_API_KEY`, while the collector and `aer doctor` document `AER_API_KEY`. Setting the documented name printed usage instead of authenticating. Either name now works everywhere.
