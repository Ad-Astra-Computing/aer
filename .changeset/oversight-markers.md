---
"@adastracomputing/aer-hooks": minor
"@adastracomputing/aer-mcp-recorder": patch
---

aer-hooks now records two new event types, human.input and approval.decided, so a completed session's record can show how much a human was supervising it. Install or doctor again to pick up the two additional hook registrations this needs.

aer-mcp-recorder's vendored ingest allowlist picked up the two new keys to stay in sync; it does not send them itself.

A pre-release security review found that a lost PreToolUse hook invocation (a crash, timeout or killed process, never reaching the collector) could get its approval.decided wrongly paired onto an unrelated open tool call, recording "allowed, prompted" for a call nobody actually prompted on. The narrow single-open-call fallback that caused this has been removed; an unmatched approval request is now always counted unresolved instead of guessed at.
