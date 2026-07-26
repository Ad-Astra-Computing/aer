# Changelog

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
