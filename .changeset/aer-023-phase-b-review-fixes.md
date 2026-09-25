---
'@adastracomputing/aer-hooks': patch
'@adastracomputing/aer-emit': patch
---

Fixes from an independent review run against Claude Code 2.1.281.

Root-session join now reads `CLAUDE_CODE_SESSION_ID` (the variable Claude
Code actually exports into the hook process's own environment) rather than
the installer's `--root-session "${CLAUDE_SESSION_ID}"` flag, which was
confirmed to expand to an empty string. The installer no longer writes that
flag; `--root-session` still works as an explicit override. An event under
its own session id that already has a session wins over the env-derived
root, matching the empirically observed case where a subagent's payload
already carries the lead's session id.

Fixes the pending-marker livelock: a tool event waiting on a still-fresh
marker now gives up with enough budget left to open for real, and drops
instead of reopening when the marker has not actually gone stale, so steady
tool traffic against a slow or hung open no longer mints a fresh token on
every invocation until the server's per-session cap trips permanently. A
subagent event can no longer open a session on the lock-lost or
no-session-id paths either.

The bundled CLI now reports the correct `aer-hooks` version instead of the
consuming CLI's own (baked in at build time rather than read from
`package.json` at runtime, which broke under a single-file bundle); the
version-staleness check clamps to a pinned floor. The nix-profile-shadow
doctor check only warns when the project actually has its own install to be
shadowed. Pid aliases now carry a process-start-time, agent id and base URL
identity check, and a dead alias is deleted rather than trusted. The
client_ref no-client_ref-retry is gated on the 400 body actually naming
`client_ref`, and a late persist from a stuck opener can no longer regress
the stored event position.
