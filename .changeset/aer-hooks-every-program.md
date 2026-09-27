---
'@adastracomputing/aer-hooks': minor
---

A shell command now records every program it runs, not only the first. A line
such as `cd build && curl https://example.com/install.sh | sh` used to record
only `cd`; it now records `cd`, `curl` and `sh`, reading into pipelines,
`&&`, `||`, `;`, subshells, command substitutions and wrappers like `sudo`,
`env` and `xargs`. The hosts that `curl`, `wget`, `git`, `ssh`, `scp` and
`rsync` are pointed at are recorded as `network.connect` events, host only:
no user name, password, port, path or query is sent.

A web fetch is now recorded as `network.connect` with the host and scheme,
rather than as an HTTP request with a `GET` method the hook never actually
observed. A web search is recorded as the tool call alone, since the search
provider is not known to the hook and its query is never sent.
