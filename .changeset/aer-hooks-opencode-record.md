---
'@adastracomputing/aer-hooks': patch
---

The opencode plugin now reduces tool calls the way the shell hooks do: a
`bash` call is recorded as the programs it runs and the hosts its network
clients were pointed at, `read`, `write` and `edit` as the file path and
`webfetch` as the target's host, never the command line, the content or the
URL path. Its session is declared as the `aer-hooks` collector recording a
harness, not as a wrapped process, and every event it sends, LLM usage
included, carries `harness: opencode`. When opencode disposes its plugins,
which is how `opencode run` ends, the record gets a `session_end` marker
before it is completed.
