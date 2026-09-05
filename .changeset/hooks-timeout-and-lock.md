---
"@adastracomputing/aer-hooks": patch
---

Raise the hard timeout from 2.5s to 10s (production session creation measures
3-4s, so the old budget abandoned most single-shot sessions before they
saved), and make it configurable with `AER_HOOK_TIMEOUT_MS`. A timeout still
exits 0 but now writes one stderr diagnostic. Fix a TOCTOU race where two
concurrent hooks for the same harness session could each open a separate AER
session: the session-store's read-decide-write sequence is now guarded by a
per-session lock file, so concurrent hooks converge on one session.
