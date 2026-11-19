---
"@adastracomputing/aer": minor
---

Add `aer sentinel-local install`, a built-in local-poll Sentinel sensor
that watches outbound TCP connections on the machine and classifies which
local processes are talking to AI-provider APIs, without reading any
process's command line, path or working directory beyond the closed-set
evidence the server contract accepts.

Install requires an explicit interactive confirmation or
`--i-understand-local-monitoring`, after showing a disclosure of exactly
what the sensor reads and what it sends upstream (destination IP/port for
a matched connection; a closed-set label, count or hash otherwise). The
daemon runs under systemd on Linux or launchd on macOS, backs off on a
revoked credential or a tenant's reversible billing hold, and halts for
good on a permanently invalid key or a deleted tenant. `aer sentinel-local
uninstall` always removes the unit/plist, credential and local state it
created; `--erase` additionally asks the server to delete this device's
retained observations.
