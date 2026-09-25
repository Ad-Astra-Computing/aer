// Evidence about the recording itself, gathered once per harness session.
//
// A tool list says what the agent did, never whether anything was missed.

// Everything here is best-effort and never throws: this runs inside a hook,
// and a hook that fails must not disturb the harness.

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { status, type Harness } from './install.js';

/**
 * The AER-wired events across every config layer the harness loads, sorted.
 *
 * All matching layers load, rather than the nearest one replacing the rest,
 * so reading only the home layer describes a registration that may not be the
 * one firing.
 */
export async function registeredEvents(
  harness: Harness,
  base?: string,
  projectDir?: string,
): Promise<string[]> {
  const found = new Set<string>();
  for (const dir of layerDirs(base, projectDir)) {
    try {
      const entries = await status({ dir });
      const mine = entries.find((e) => e.harness === harness);
      for (const ev of mine?.wiredEvents ?? []) found.add(ev);
    } catch {
      /* a layer we cannot read contributes nothing */
    }
  }
  return [...found].sort();
}

/**
 * Where each layer's config lives, as a base directory `configPathFor` can
 * resolve. Claude Code and Codex both read a project copy under the working
 * directory in the same relative place as the home one.
 */
function layerDirs(base: string | undefined, projectDir: string | undefined): string[] {
  const dirs = [base ?? os.homedir()];
  if (projectDir !== undefined && projectDir.length > 0) {
    const resolved = path.resolve(projectDir);
    if (!dirs.includes(resolved)) dirs.push(resolved);
  }
  return dirs;
}

/**
 * This package's version, reported so a record names the code that made it.
 * Baked in at build time (scripts/write-version.mjs generates
 * version.generated.ts from package.json) rather than read from package.json
 * at RUNTIME via `import.meta.url`: a consumer that bundles this package
 * into its own single-file build (apps/cli's esbuild output does) collapses
 * every module's import.meta.url to the bundle's own path, so a relative
 * `../package.json` read silently lands on the CONSUMER's manifest instead
 * (reviewer-confirmed: apps/cli 0.2.0 read where aer-hooks 0.3.0 was meant).
 * A literal string constant has no such failure mode.
 */
export { HOOKS_VERSION } from './version.generated.js';

const SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** Read a file only if it is a regular file, never through a link. */
function readPlainFile(file: string): string | undefined {
  try {
    const st = lstatSync(file);
    if (!st.isFile()) return undefined;
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * The commit the working tree is on, or nothing. Read from the files rather
 * than by running git, and validated as a commit id: HEAD is an ordinary
 * file in the working tree and its content is not ours.
 */
export function repoHead(cwd: string | undefined): string | undefined {
  if (cwd === undefined || cwd.length === 0) return undefined;
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < 64; depth++) {
    const git = path.join(dir, '.git');
    if (existsSync(git)) {
      try {
        // A linked worktree points at its real git dir through a file, and a
        // symlink could point anywhere at all. Neither is followed.
        if (!lstatSync(git).isDirectory()) return undefined;
      } catch {
        return undefined;
      }
      return headOf(git);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

function headOf(gitDir: string): string | undefined {
  const head = readPlainFile(path.join(gitDir, 'HEAD'))?.trim();
  if (head === undefined) return undefined;
  if (SHA.test(head)) return head;
  const ref = head.startsWith('ref: ') ? head.slice('ref: '.length).trim() : undefined;
  // Only a ref path, so a crafted HEAD cannot name a file elsewhere.
  if (ref === undefined || !/^refs\/[A-Za-z0-9._\/-]+$/.test(ref) || ref.includes('..')) return undefined;
  const direct = readPlainFile(path.join(gitDir, ...ref.split('/')))?.trim();
  if (direct !== undefined && SHA.test(direct)) return direct;
  // A packed ref is the common case on a fresh clone.
  const packed = readPlainFile(path.join(gitDir, 'packed-refs'));
  if (packed === undefined) return undefined;
  for (const line of packed.split('\n')) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === ref && sha !== undefined && SHA.test(sha)) return sha;
  }
  return undefined;
}
