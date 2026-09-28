---
'@adastracomputing/aer-auto-node': minor
---

The usage policy is now fetched once per agent when the collector starts,
kept for 5 minutes and refreshed in the background, instead of being fetched
by every session when its first call arrived. A block-mode policy therefore
governs the first call of a process too, on the OpenAI, Anthropic and Vercel
AI SDK paths. The only call that can wait is one made while that first fetch
is still in flight: it waits for the answer, never more than 3 seconds after
the fetch started, and then goes ahead ungoverned if none came. Once an
answer has arrived no call waits, whatever the mode.
