// A purpose-built basename/argv-to-tool table for the Sentinel local-poll
// classifier (design doc §3.4, step 2/3). Deliberately not a reuse of
// `providerOf()` (apps/cli/src/shared/model-usage.ts), which maps a model
// NAME to a vendor and has no notion of an executable/script path at all.
// New, standalone, with its own vector-test corpus.

import type { Tool } from './types.js';

/** Interpreter basenames whose argv must be inspected to find the real tool
 * (the interpreter itself is never itself a Tool value). */
export const KNOWN_INTERPRETERS = new Set(['node', 'nodejs', 'python3', 'python', 'bun', 'deno']);

/** Standalone AI CLI binary basenames that classify directly, without
 * inspecting argv. Reuses the Harness names from
 * packages/aer-hooks/src/install.ts's `Harness` type ('claude-code', 'codex',
 * 'antigravity') for the tools that are also a checkable harness, so the
 * Tool/Harness vocab stays one list, not two independently-spelled ones. */
export const STANDALONE_CLI_BASENAMES: Record<string, Tool> = {
  claude: 'claude_code',
  codex: 'codex',
  cursor: 'cursor',
  'cursor-agent': 'cursor',
  copilot: 'copilot',
  'github-copilot-cli': 'copilot',
  antigravity: 'antigravity',
  gemini: 'gemini_cli',
  aider: 'aider',
  opencode: 'opencode',
};

/** Known browser basenames (platform variants included). A process matching
 * one of these classifies as 'browser' and MUST STOP: never produces a row,
 * regardless of destination (design doc §3.4 step 4). */
export const BROWSER_BASENAMES = new Set([
  'chrome', 'google-chrome', 'chromium', 'chromium-browser',
  'firefox', 'firefox-esr',
  'safari',
  'msedge', 'microsoft-edge', 'msedge-stable',
  'brave', 'brave-browser',
  'arc',
  'opera', 'vivaldi',
]);

// A script/package signature recognizable from an interpreter's argv (see
// classify.ts's `interpreterSignature`), e.g. `node:@anthropic-ai/claude-code`.
// Node's `process.title` setter overwrites argv memory on Linux, so a
// title-setting agent may show just the title string; the 'claude-code
// title' entries below cover that captured case.
export const INTERPRETER_SCRIPT_SIGNATURES: Record<string, Tool> = {
  // Claude Code, launched via its node entry point or npx/npm wrapper.
  'node:@anthropic-ai/claude-code': 'claude_code',
  'node:claude-code': 'claude_code',
  // Linux: process.title overwrites /proc/<pid>/cmdline's argv[0] memory;
  // Claude Code sets its own title to this string.
  'node:claude': 'claude_code',
  // Codex CLI's node entry point (npm-distributed form).
  'node:@openai/codex': 'codex',
  'node:codex-cli': 'codex',
  // opencode's node entry point.
  'node:opencode-ai': 'opencode',
  'node:opencode': 'opencode',
  // Aider ships as a Python package/console-script.
  'python3:aider': 'aider',
  'python:aider': 'aider',
  // Gemini CLI, when launched as a Node package rather than the standalone binary.
  'node:@google/gemini-cli': 'gemini_cli',
  'node:gemini-cli': 'gemini_cli',
};

export interface ClassificationResult {
  processClass: 'known_ai_cli' | 'browser';
  tool?: Tool;
}

/** Classifies a basename that is NOT a known interpreter: a standalone CLI
 * binary, a browser, or neither (returns undefined - no row). */
export function classifyStandaloneBasename(basename: string): ClassificationResult | undefined {
  const tool = STANDALONE_CLI_BASENAMES[basename];
  if (tool) return { processClass: 'known_ai_cli', tool };
  if (BROWSER_BASENAMES.has(basename)) return { processClass: 'browser' };
  return undefined;
}
