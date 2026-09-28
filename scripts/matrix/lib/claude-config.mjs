/**
 * Undo what a Claude Code run adds to the user's real ~/.claude.json.
 *
 * The claude-code suite runs the signed-in claude with the real HOME, so
 * every throwaway project it opens is remembered there under `projects`
 * (the answer to "Do you trust this folder?", among other things). This
 * removes exactly those keys and nothing else: it never prints the file,
 * never touches another key, and only ever removes a path it is handed that
 * is one of the matrix's own temporary project directories.
 */
import { readFileSync, writeFileSync, renameSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

/** A temporary project directory the claude-code suite creates, and only that. */
export const MATRIX_CLAUDE_PROJECT = /\/aer-matrix-[A-Za-z0-9]{6}\/cases\/claude-code-[A-Za-z0-9]{6}\/cc-proj-[A-Za-z0-9]{6}$/;

/**
 * Remove the `projects` entries for `paths` from `file` (default
 * ~/.claude.json). Paths that are not the matrix's own are refused. Returns
 * how many entries were removed. Written atomically with the file's mode
 * kept, and not written at all when there is nothing to remove.
 */
export function forgetClaudeProjects(paths, { file = join(homedir(), '.claude.json'), allow = MATRIX_CLAUDE_PROJECT } = {}) {
  const mine = paths.filter((p) => typeof p === 'string' && allow.test(p));
  if (mine.length === 0 || !existsSync(file)) return 0;
  const mode = statSync(file).mode & 0o777;
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const projects = config?.projects;
  if (!projects || typeof projects !== 'object') return 0;
  let removed = 0;
  for (const p of mine) {
    if (Object.prototype.hasOwnProperty.call(projects, p)) {
      delete projects[p];
      removed += 1;
    }
  }
  if (removed === 0) return 0;
  const tmp = join(dirname(file), `.claude.json.aer-matrix-${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(config, null, 2), { mode });
  renameSync(tmp, file);
  return removed;
}
