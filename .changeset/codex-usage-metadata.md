---
"@adastracomputing/aer-hooks": minor
---

Record model/token usage for Codex CLI, mirroring the Claude Code transcript
path. A Codex hook payload carries no usage of its own, but it does carry
`transcript_path`, pointing at Codex's own rollout JSONL file, which contains
a `token_usage_record` line per completed response (input/output token
counts; no prompt, completion or tool content). PostToolUse/turn end/
SessionEnd now read that line (bounded, incremental, bodies-off) and emit an
`llm.completed` event using the model Codex already sends on every hook
event, alongside the existing tool events.
