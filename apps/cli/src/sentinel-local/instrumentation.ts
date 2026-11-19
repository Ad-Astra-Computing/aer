// Tool -> Harness mapping and the live, at-poll-time instrumentation check
// (design doc §3.4). `instrumentation` is a LABEL, computed fresh every poll,
// never a suppression: a classified process always produces a row regardless
// of this result. It is also self-reported and unverified - a config file
// consistent with AER hooks being wired, not proof the harness's events
// actually reach AER.

import { status, type Harness } from '@adastracomputing/aer-hooks';
import type { Instrumentation, Tool } from './types.js';

// Only a Tool `status()` can actually check (claude-code, codex, antigravity)
// maps to a Harness. Any other Tool always reports `not_checkable`: there is
// no real programmatic check for it in this repo today.
const TOOL_TO_HARNESS: Partial<Record<Tool, Harness>> = {
  claude_code: 'claude-code',
  codex: 'codex',
  antigravity: 'antigravity',
};

export interface InstrumentationCheckDeps {
  /** The process's own cwd, if determinable on this platform/tick (Linux:
   * readlink /proc/<pid>/cwd; macOS: the scoped third lsof call). undefined
   * means the project-scope check is skipped, not treated as 'none'. */
  processCwd?: string | undefined;
}

// Checks both the home-config scope and (when available) the process's cwd
// scope. `hooks_configured` if either scope's wiredEvents is non-empty, else
// `none` - unless the Tool isn't checkable at all, in which case
// `not_checkable` regardless of any config file.
export async function checkInstrumentation(tool: Tool, deps: InstrumentationCheckDeps = {}): Promise<Instrumentation> {
  const harness = TOOL_TO_HARNESS[tool];
  if (!harness) return 'not_checkable';

  const scopes: Array<{ dir?: string }> = [{}];
  if (deps.processCwd) scopes.push({ dir: deps.processCwd });

  for (const scope of scopes) {
    const entries = await status(scope);
    const entry = entries.find((e) => e.harness === harness);
    if (entry && entry.exists && entry.wiredEvents.length > 0) return 'hooks_configured';
  }
  return 'none';
}
