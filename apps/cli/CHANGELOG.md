# Changelog

## 0.1.3

### Patch Changes

- [`a8a5c01`](https://github.com/Ad-Astra-Computing/aer/commit/a8a5c019393e0a7f575ec272a304d8159d310167) - Publish an entry point that cannot decline to run. The bundle previously
  contained a guard deciding whether it was the process entry, which in a
  bin-only package could produce exactly one failure: deciding wrongly and
  exiting 0 in silence. That is what shipped in 0.1.1. The published bundle now
  starts from a wrapper that simply runs, and the guard lives only in the source
  the tests import. Covered by tests that install the packed tarball and run the
  installed binary.

## 0.1.2

### Patch Changes

- [`c34c6f9`](https://github.com/Ad-Astra-Computing/aer/commit/c34c6f98e35264a5f1da9d90f451e54ff702a104) - Run the CLI when it is invoked through its installed `bin` symlink. npm links
  `node_modules/.bin/aer` to `dist/main.js`, and Node resolves that symlink for
  `import.meta.url` but not for `process.argv[1]`, so the entry-point guard
  comparing the two verbatim was false for every installed copy. `npx
  @adastracomputing/aer <anything>` loaded, ran nothing and exited 0, printing no
  output and looking like success to a script. Both sides are now resolved, the
  way `aer-hooks` and `aer-mcp-recorder` already did it.

## 0.1.1

### Patch Changes

- [`0dc1bfd`](https://github.com/Ad-Astra-Computing/aer/commit/0dc1bfd919a421416a86d779348e9ac30f967526) - Fix `aer smoke` crashing with ERR_AMBIGUOUS_MODULE_SYNTAX, `aer init --entry`
  silently succeeding when the named script does not exist, `aer doctor` not
  accepting AER_TENANT_API_KEY, raw stack traces on `aer verify`/`aer ingest`
  HTTP errors and `aer commitments verify` accepting a signature from an
  unpinned key that `aer verify` would reject.

- [`873d85b`](https://github.com/Ad-Astra-Computing/aer/commit/873d85bb88f9c8ec5ff561d18f8be3d19e6fefe9) - `--help`/`-h` anywhere in the command line now prints usage and exits before
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

## 0.1.0 - 2026-07-26

Initial release of the `aer` command line.

- `aer init`, `aer doctor` and `aer smoke` to wire auto-instrumentation into a
  Node project and check the integration end to end.
- `aer ingest` for JSONL event batches and `aer import claude-code` for post-hoc
  transcript import (bodies-off).
- `aer verify` for local signature verification of a published AER and
  `aer commitments verify` for offline content-commitment opening.
- Tenant operations: agents, sessions, findings, AER listing and download,
  baselines, audit log and webhook management.
