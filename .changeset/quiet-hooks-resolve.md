---
"@adastracomputing/aer-hooks": patch
---

The installer now writes a hook command the harness can actually run. It resolves `aer-hook` only on a persistent PATH directory, skipping the ephemeral `node_modules/.bin` that npm and npx put in front of the installer's own PATH but never give the harness, and otherwise pins the single-quoted absolute path of the `cli.js` built by this same install. Paths are single-quoted for the shell the harness runs them through, and a path carrying a control character is refused rather than written.

`aer-hooks status` reports when a wired command no longer resolves. Uninstall and idempotency match only our own hook, so a user's unrelated `node other/cli.js --harness ...` entry is left alone, and `hookCommandResolves` never throws on a hand-written command.

A lifecycle test runs the built binary through SessionStart, PreToolUse, PostToolUse and Stop against a stand-in API and proves one AER session opens and completes, plus the fail-open promise (exit 0, empty stdout) against an unreachable API.
