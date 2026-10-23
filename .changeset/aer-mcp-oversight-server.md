---
"@adastracomputing/aer": minor
---

Add `aer mcp serve`, a stdio Model Context Protocol server built into the
CLI, and `aer mcp login`, a device-flow login labelled for an AI assistant.
Nine read-only tools (`list_agents`, `get_agent`, `list_sessions`,
`get_session`, `list_session_events`, `get_session_hosts`, `list_findings`,
`get_baseline`, `search_observations`) wrap the same tenant-authenticated
REST routes the CLI already calls, with an explicit field projection per
tool and read-path re-sanitization of every event payload, so this new
surface never returns more than ingest would accept today. The server
refuses to start with an admin-role key unless `--allow-admin-key`, enforces
its own 60/min client-side rate ceiling, and requires the tenant to opt in
server-side before any tool call succeeds.
