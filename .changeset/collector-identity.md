---
"@adastracomputing/aer-emit": minor
"@adastracomputing/aer-hooks": patch
---

emit: say which collector opened the session

The API has stored `collector_name` and `collector_version` since migration
0040, and nothing ever sent them, so the field was null for every session AER
has opened. `createHttpSink` now takes `collector` and puts it in the
session-open body, and the hook declares itself. A reader can tell a harness
recording from a wrapped process without inferring it from the events.
