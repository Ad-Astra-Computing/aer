---
'@adastracomputing/aer-auto-node': patch
---

A tool name the model returns is now recorded only when the AER API would
accept it: a string of at most 512 UTF-16 code units with no control
characters. Any other name is recorded as `(unrecordable tool name)` and
counted in that provider's `tool_names_replaced` in `adapter_activity`, so a
model that returns an oversized or malformed name no longer gets the whole
`tool.selected` event refused. This applies to the OpenAI, Anthropic and
Vercel AI SDK paths, streamed or not.
