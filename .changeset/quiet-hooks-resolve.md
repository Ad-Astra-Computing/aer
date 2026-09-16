---
"@adastracomputing/aer-hooks": patch
---

The installer now checks that the `aer-hook` command it writes can actually run. `npx @adastracomputing/aer-hooks install claude-code` wrote `aer-hook --harness claude-code` into the harness config while `npx` puts nothing on `PATH`, so every event failed with a command the harness could not find. When `aer-hook` is not on `PATH` the installer writes the absolute path of its own copy and says so, and `aer-hooks status` reports whether each wired command resolves.

A lifecycle test now runs the built binary through SessionStart, PreToolUse, PostToolUse and Stop against a stand-in API and holds the fail-open promise there: exit 0, nothing on stdout, one session opened and completed.
