---
"@adastracomputing/aer-hooks": minor
---

Record which program on a shell line named each host a `network.connect`
shape carries (a `via` key, e.g. `curl` or `git`), so `curl host && git
clone host` on the same line no longer loses which tool actually reached
the network. A fetch-tool call (`WebFetch` and its harness equivalents) now
also carries `source: 'fetch_tool'` on its `network.connect` shape, matching
the `source` every other network path already reports. Both fixes live in
the shared reduction `opencode`, Claude Code and Codex all route through, so
every harness gets them for free.
