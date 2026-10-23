---
"@adastracomputing/aer-hooks": patch
"@adastracomputing/aer-mcp-recorder": patch
---

Record Claude Code's `ConfigChange` hook as a new `config.changed` event: a closed-set feature snapshot and diff of the settings file, computed client-side, record-only (no detection rule yet).
