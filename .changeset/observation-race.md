---
"@adastracomputing/aer-auto-node": patch
---

collector: do not lose a completion to the close that raced it

The adapter observes the SDK's promise rather than replacing it, to keep the
SDK's own promise type. Adopting a foreign thenable costs extra microtask
ticks, so the caller's `await` could run first, complete the session, and
flush before `llm.completed` was emitted. The record then showed a model call
that was requested and never finished, losing the model and the token counts
with it. Anthropic's `APIPromise` lost this race most often.

Completing a session now waits for the observations already in flight.
