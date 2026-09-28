---
'@adastracomputing/aer-auto-node': minor
---

The usage policy is now fetched when the collector starts, for the
configured agent, instead of by every session when its first call arrived.
A session for another agent fetches that agent's policy when its first
session starts. The answer is kept per agent for the process; each session
keeps the policy it started with, and a session started more than 5 minutes
after the last fetch starts a refresh and uses the previous answer until it
arrives. A block-mode policy therefore governs the first call of a process
too, on the OpenAI, Anthropic and Vercel AI SDK paths. The only call that
can wait is one made while the first fetch for its agent is still in flight:
it waits for the answer, never more than 3 seconds after the fetch started,
and then goes ahead ungoverned if none came. Once an answer has arrived no
call waits, whatever the mode.
