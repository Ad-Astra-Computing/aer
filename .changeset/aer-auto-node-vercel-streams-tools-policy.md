---
'@adastracomputing/aer-auto-node': minor
---

Vercel AI SDK calls are now recorded completely. A streamed call
(`streamText`, `streamObject`) records its token counts and finish reason
when your code has read the stream, instead of completing without them the
moment the stream opened. A stream that fails or is aborted is recorded as a
failed call rather than a success. Tool calls the model makes are recorded as
`tool.selected` with the tool name, streamed or not. A usage policy in block
mode now applies on the Vercel path too, so a call to a denied model that
used to go through now throws `AerPolicyError` before the request is sent.
