---
'@adastracomputing/aer-auto-node': patch
---

A tool name the model returns is now recorded only when the record can keep
it: a string of at most 200 UTF-16 code units with no control characters.
The AER API accepts names up to 512, but a longer name would break the
commitment the record keeps for that call's tool arguments. Any other name
is recorded as `(unrecordable tool name)` and counted in that provider's
`tool_names_replaced` in `adapter_activity`, so a model that returns an
oversized or malformed name no longer gets the whole `tool.selected` event
refused. This applies to the OpenAI, Anthropic and Vercel AI SDK paths,
streamed or not.
