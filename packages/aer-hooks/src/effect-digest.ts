// Effects recording (P0-2): the client-side half of the file-content-digest
// gate. Workspace location, the hashable-class allowlist, lstat-based
// symlink/non-regular-file refusal, and the HMAC read itself. The server
// never trusts any of this (enforceEffectDigestPolicy re-derives the class
// independently); this module exists so a well-behaved client does not even
// attempt a digest it knows will be refused.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { hashFileDigest } from '@adastracomputing/aer-emit';
import { classifyPath, hasGitSegment, HASHABLE_PATH_CLASSES, type PathClass } from './shared/path-class-mirror.js';

/** Per-file cap: SHA-256 of 10 MiB is tens of milliseconds even un-accelerated. */
export const MAX_FILE_DIGEST_BYTES = 10 * 1024 * 1024;
/** Per-invocation cap across every file one tool_start/tool_end names
 *  (MultiEdit, a Codex patch): four times the per-file cap. */
export const MAX_AGGREGATE_DIGEST_BYTES = 32 * 1024 * 1024;

export type HashStatus =
  | 'ok' | 'credential_class' | 'size' | 'unreadable'
  | 'symlink' | 'not_regular_file' | 'outside_workspace' | 'no_key';

/** Walk up from cwd looking for a `.git` directory; fall back to cwd itself
 *  (the harness's reported cwd) when none is found, and to undefined when
 *  there is no cwd at all. */
export function findWorkspaceRoot(cwd: string | undefined): string | undefined {
  if (cwd === undefined || !path.isAbsolute(cwd)) return cwd;
  let dir = cwd;
  for (;;) {
    try {
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
    } catch {
      /* fall through to the parent */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return cwd;
    dir = parent;
  }
}

function isInsideWorkspace(p: string, root: string): boolean {
  const rel = path.relative(root, p);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export interface GateResult {
  hashable: boolean;
  pathClass: PathClass | null;
  /** Set only when hashable is false. */
  status?: 'outside_workspace' | 'credential_class';
}

/**
 * The gate, in order: workspace location, then the `.git` exclusion, then
 * the hashable-class allowlist. Mirrors (never replaces) the server's
 * independent check.
 */
export function gateDecision(filePath: string, workspaceRoot: string | undefined): GateResult {
  if (workspaceRoot === undefined || !path.isAbsolute(filePath) || !isInsideWorkspace(filePath, workspaceRoot)) {
    return { hashable: false, pathClass: null, status: 'outside_workspace' };
  }
  if (hasGitSegment(filePath)) {
    return { hashable: false, pathClass: null, status: 'outside_workspace' };
  }
  const pathClass = classifyPath(filePath);
  if (!HASHABLE_PATH_CLASSES.has(pathClass)) {
    return { hashable: false, pathClass, status: 'credential_class' };
  }
  return { hashable: true, pathClass };
}

export interface DigestOutcome {
  status: HashStatus;
  sha256?: string;
  bytes?: number;
}

/** True exactly when the path does not exist at all (a brand-new file). */
async function missing(filePath: string): Promise<boolean> {
  try {
    await fsp.lstat(filePath);
    return false;
  } catch {
    return true;
  }
}

/**
 * Hash one file for the effects-recording digest. `budget` is mutated and
 * SHARED across every file one tool_start/tool_end names, so the aggregate
 * cap is enforced across all of them, never per file alone. Returns
 * `{ status: 'unreadable' }` (never an error state meaning "new file") for a
 * missing path; the caller decides whether a missing BEFORE-read is a new
 * file (fine) or a missing AFTER-read is a failed write (not fine).
 */
export async function hashFileForEffectDigest(
  filePath: string,
  workspaceRoot: string | undefined,
  key: Buffer | null,
  budget: { remainingBytes: number },
): Promise<DigestOutcome> {
  if (key === null) return { status: 'no_key' };
  const gate = gateDecision(filePath, workspaceRoot);
  if (!gate.hashable) return { status: gate.status! };

  let st: fs.Stats;
  try {
    st = await fsp.lstat(filePath);
  } catch {
    return { status: 'unreadable' };
  }
  if (st.isSymbolicLink()) return { status: 'symlink' };
  if (!st.isFile()) return { status: 'not_regular_file' };
  if (st.size > MAX_FILE_DIGEST_BYTES || st.size > budget.remainingBytes) return { status: 'size' };

  try {
    const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    const { hex, bytes } = await hashFileDigest(key, stream);
    budget.remainingBytes -= bytes;
    return { status: 'ok', sha256: hex, bytes };
  } catch {
    return { status: 'unreadable' };
  }
}

/**
 * The BEFORE read at tool_start. A missing file is a new file, not a
 * failure: it still stashes (so tool_end can tell "no before because new
 * file" apart from "no stash at all"), just with no sha256Before. Any other
 * failure (symlink, size, unreadable) also stashes with no sha256Before; the
 * AFTER read at tool_end re-runs the gate and lstat from scratch anyway, so
 * a transient before-phase failure never produces a wrong final status.
 */
export async function hashBeforeDigest(
  filePath: string,
  workspaceRoot: string | undefined,
  key: Buffer | null,
  budget: { remainingBytes: number },
): Promise<string | undefined> {
  if (await missing(filePath)) return undefined;
  const outcome = await hashFileForEffectDigest(filePath, workspaceRoot, key, budget);
  return outcome.status === 'ok' ? outcome.sha256 : undefined;
}
