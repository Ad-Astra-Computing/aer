---
'@adastracomputing/aer-hooks': patch
---

The opencode plugin now records what the shell hooks record. Its session is
declared as the `aer-hooks` collector recording a harness, not as a wrapped
process, and every event carries `harness: opencode`. A `bash` call is
reduced to the programs it runs and the hosts its network clients were
pointed at, `read`, `write` and `edit` record the file path and `webfetch`
the target's host, never the command line, the content or the URL path.
When opencode disposes its plugins, which is how `opencode run` ends, the
record gets a `session_end` marker before it is completed.
