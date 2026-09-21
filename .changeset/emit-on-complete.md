---
"@adastracomputing/aer-emit": minor
---

sink: report whether the session actually completed

`onComplete(ok)` fires on close when this sink owns the completion, mirroring
`onOpen`. A failed `POST /complete` was previously only a line on stderr, so a
caller holding recovery state had no way to know the record was not closed and
would discard what it needed to finish the session later.
