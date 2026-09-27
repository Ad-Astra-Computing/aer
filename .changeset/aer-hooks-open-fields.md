---
'@adastracomputing/aer-hooks': patch
---

The hooks and the opencode plugin now always send an agent version when they
open a session, recording `unspecified` when `AER_AGENT_VERSION` is not set.
The AER API requires one, so without that variable every session open was
refused and nothing was recorded. `AER_ENV_ID` is likewise required by the
API: without it the hook now records nothing and says why on stderr, rather
than queuing events for a session that can never open, and the README lists
it as required.
