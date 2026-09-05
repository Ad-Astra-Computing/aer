---
"@adastracomputing/aer": patch
---

`--help`/`-h` anywhere in the command line now prints usage and exits before
any file write or network call, instead of running the command. Every
user-supplied id interpolated into a request URL (session, AER, agent,
webhook) is now percent-encoded as a single path segment, closing a
path-segment injection gap. `aer commitments verify --bundle` no longer
requires `AER_BASE_URL`: pass `--key <public-key.json>` for a fully offline
signature check, or set `AER_BASE_URL` to fetch the key; with neither, the
command refuses to run rather than report an unverified match. `aer ingest`
now surfaces a sample of the gateway's per-event validation errors instead of
only a rejected count. `aer init --session` rejects an unrecognized value
(exit 64) instead of silently falling back to `process`, and `--dry-run`
correctly labels a not-yet-existing file as `create` rather than
`overwrite`. Server response text printed to the terminal is now stripped of
control characters and capped in length.
