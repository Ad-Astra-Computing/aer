---
"@adastracomputing/aer-hooks": patch
---

Read Codex usage events' provider off the real session_meta field instead of guessing it from the model name, fixing provider attribution for sessions routed through a non-OpenAI backend (for example --oss/local-provider).
