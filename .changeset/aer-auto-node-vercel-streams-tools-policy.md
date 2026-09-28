---
'@adastracomputing/aer-auto-node': patch
---

Vercel AI SDK calls are now recorded completely. A streamed call
(`streamText`, `streamObject`) records its token counts and finish reason
when your code has read the stream, instead of completing without them the
moment the stream opened. A stream that fails or is aborted is recorded as a
failed call rather than a success. Tool calls the model makes are recorded as
`tool.selected` with the tool name, streamed or not. A usage policy in block
mode now refuses a denied model on the Vercel path before the request is
sent, including the first call of a session, which waits up to three seconds
for the session's policy to arrive. The README now describes where the
Vercel AI SDK is instrumented and which provider packages are covered.
