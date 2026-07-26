// @adastracomputing/aer-hooks — fail-open, redaction-by-default hook adapters.
//
// Claude Code and OpenAI Codex CLI fire shell hooks that pass a JSON event on
// stdin. This package normalizes both harnesses' payloads to one shape, emits the
// tool events into AER (best-effort, never blocking the harness) and ships a safe
// installer that wires the hooks into each harness config.
//
// opencode is supported natively via its JS plugin API (see the opencode exports
// below) — this catches bash/read/write/edit tools the MCP recorder never sees.
// Cline and other MCP-native harnesses are covered by @adastracomputing/aer-mcp-recorder.

export {
  normalize,
  normalizeClaudeCode,
  normalizeCodex,
  detectHarness,
  recordArgsEnabled,
} from './normalize.js';
export type { HookEvent, HookKind, Harness } from './normalize.js';

export { emitHookEvent } from './core.js';
export type { EmitOptions } from './core.js';

// opencode is a JS-PLUGIN harness (not a stdin shell hook), so it gets its own
// in-process adapter: normalizers + a plugin factory that manages one AER session
// per opencode session. Native plugin capture beats MCP-only (catches bash/read/
// write/edit tools the MCP recorder never sees).
export {
  normalizeOpencodeToolBefore,
  normalizeOpencodeToolAfter,
  normalizeOpencodeEvent,
  normalizeOpencodeMessage,
} from './opencode.js';
export type {
  OpencodeToolBeforeInput,
  OpencodeToolBeforeOutput,
  OpencodeToolAfterInput,
  OpencodeToolAfterOutput,
  OpencodeLlm,
} from './opencode.js';
export { createAerOpencodeHooks, aerOpencodePlugin } from './opencode-plugin.js';
export type { OpencodeHooks, AerOpencodeDeps } from './opencode-plugin.js';

export {
  install,
  uninstall,
  status,
  configPathFor,
  AER_HOOK_MARKER,
} from './install.js';
export type {
  InstallOptions,
  InstallResult,
  UninstallResult,
  StatusEntry,
} from './install.js';
