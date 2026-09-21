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

A second cause sat underneath it. `drain` returned early when a send was
already in flight, and the close path called that same `drain`, so an event
captured mid-send stayed in the queue and the session closed without it. A
drain now joins the send already running and keeps going until the queue is
empty, so a completion that arrives during a flush is still delivered.
