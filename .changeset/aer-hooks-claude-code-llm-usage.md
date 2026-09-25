---
'@adastracomputing/aer-hooks': minor
---

Claude Code hook sessions now carry model and token counts.
`hook_event_name` payloads never include `model` or usage, so a
hooks-recorded session had tool events and no `llm.completed` at all. On
PostToolUse, Stop, SubagentStop and SessionEnd, the collector now reads the
Claude Code transcript (`transcript_path`, present on every payload)
incrementally from a persisted byte offset, extracts only `message.model`
and `message.usage` from newly-appeared assistant entries, and emits
`llm.completed`. Bodies-off throughout: no prompt, completion text or tool
content is read or emitted, streamed duplicate entries for the same message
are recorded once with their final usage, a missing or unreadable transcript
is silent, and the read is bounded per invocation. The updated read offset
and message-id dedup state are saved to the session store before the network
send that follows, the same way the event sequence counter already is, so a
slow or failed send never risks the next hook rescanning and double-reporting
what this one already claimed.
