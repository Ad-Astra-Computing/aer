// Classification order (design doc §3.4): interpreter basename -> argv
// signature lookup; else standalone CLI basename; else browser (stop, no
// row); else undefined (no row). Reads argv/exe path locally to compute a
// label; never sends either over the wire.

import {
  KNOWN_INTERPRETERS,
  INTERPRETER_SCRIPT_SIGNATURES,
  classifyStandaloneBasename,
  type ClassificationResult,
} from './interpreter-tool-table.js';

/** basename(path), without relying on node:path (keeps this module
 * dependency-free and trivially unit-testable on either POSIX or Windows
 * separators, though this sensor only ships for Linux/macOS). */
export function basenameOf(execPath: string): string {
  const normalized = execPath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter((p) => p.length > 0);
  return parts.length > 0 ? parts[parts.length - 1]! : execPath;
}

// Derives a short classifier key from an interpreter's argv, e.g.
// `node:@anthropic-ai/claude-code`: a node_modules path extracts <pkg>, a
// bare console-script name is used as-is, and anything else falls back to
// its parent directory name.
export function interpreterSignature(interpreter: string, argv: string[]): string | undefined {
  // argv[0] is the interpreter path/name itself; look at what follows.
  const rest = argv.slice(1).filter((a) => a.length > 0 && !a.startsWith('-'));
  const candidate = rest[0];
  if (!candidate) return undefined;

  // node_modules/<@scope/pkg or pkg>/... -> the package name.
  const nmMatch = candidate.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (nmMatch) return `${interpreter}:${nmMatch[1]}`;

  // A bare package/console-script name with no path separators at all
  // (e.g. `aider`, `opencode`), or Node's process.title overwrite case
  // (argv shows just the title string, e.g. `claude`).
  if (!candidate.includes('/')) return `${interpreter}:${candidate}`;

  // A path ending in a recognizable directory/basename, e.g.
  // /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js already
  // matched above via node_modules; fall back to the immediate parent dir
  // name for anything else resembling <pkg-dir>/<entry>.js.
  const segs = candidate.split('/').filter(Boolean);
  if (segs.length >= 2) {
    const parent = segs[segs.length - 2]!;
    return `${interpreter}:${parent}`;
  }
  return `${interpreter}:${basenameOf(candidate)}`;
}

/** Normalizes an interpreter basename (python3/python/node/nodejs/bun/deno)
 * to the canonical key used in INTERPRETER_SCRIPT_SIGNATURES. */
function canonicalInterpreter(basename: string): string {
  if (basename === 'nodejs') return 'node';
  return basename;
}

export function classifyProcess(execBasename: string, argv: string[]): ClassificationResult | undefined {
  if (KNOWN_INTERPRETERS.has(execBasename)) {
    const interp = canonicalInterpreter(execBasename);
    const sig = interpreterSignature(interp, argv);
    if (!sig) return undefined;
    const tool = INTERPRETER_SCRIPT_SIGNATURES[sig];
    if (!tool) return undefined;
    return { processClass: 'known_ai_cli', tool };
  }
  return classifyStandaloneBasename(execBasename);
}
