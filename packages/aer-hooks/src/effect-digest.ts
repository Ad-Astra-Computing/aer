// Effects recording (P0-2): the client-side half of the file-content-digest
// gate. Workspace location, the hashable-class allowlist, lstat-based
// symlink/non-regular-file refusal, and the HMAC read itself. The server
// never trusts any of this (enforceEffectDigestPolicy re-derives the class
// independently); this module exists so a well-behaved client does not even
// attempt a digest it knows will be refused.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { hashFileDigest } from '@adastracomputing/aer-emit';
import {
  classifyPathForHashing,
  hasGitSegmentForHashing,
  HASHABLE_PATH_CLASSES,
  type PathClass,
} from './shared/path-class-mirror.js';

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
// Security review F9: refuse a degenerate root ($HOME or /) here, the
// enforcement point, rather than changing findWorkspaceRoot's own fallback.
// path.resolve on both sides strips a trailing slash (round 2 confirmation:
// a trailing slash on $HOME otherwise defeated the comparison).
function isDegenerateRoot(root: string): boolean {
  const resolved = path.resolve(root);
  return resolved === path.resolve(os.homedir()) || resolved === path.parse(resolved).root;
}

export function gateDecision(filePath: string, workspaceRoot: string | undefined): GateResult {
  if (
    workspaceRoot === undefined ||
    !path.isAbsolute(filePath) ||
    isDegenerateRoot(workspaceRoot) ||
    !isInsideWorkspace(filePath, workspaceRoot)
  ) {
    return { hashable: false, pathClass: null, status: 'outside_workspace' };
  }
  if (hasGitSegmentForHashing(filePath)) {
    return { hashable: false, pathClass: null, status: 'outside_workspace' };
  }
  const pathClass = classifyPathForHashing(filePath);
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

// Security review F1: gateDecision's checks are lexical, so a symlinked
// ancestor directory, or the root itself being a symlink to $HOME or /, is
// invisible to them. realpath both sides and re-check (F1-R1, F9 round 2).
type WorkspaceResolution = { escapes: true } | { escapes: false; resolvedPath: string };

async function resolveAgainstWorkspace(filePath: string, workspaceRoot: string): Promise<WorkspaceResolution> {
  try {
    const [realParent, realRoot] = await Promise.all([
      fsp.realpath(path.dirname(filePath)),
      fsp.realpath(workspaceRoot),
    ]);
    if (isDegenerateRoot(realRoot)) return { escapes: true };
    const resolvedPath = path.join(realParent, path.basename(filePath));
    if (!isInsideWorkspace(resolvedPath, realRoot) && realParent !== realRoot) return { escapes: true };
    return { escapes: false, resolvedPath };
  } catch {
    return { escapes: true };
  }
}

const O_NOFOLLOW_NONBLOCK = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/**
 * Hash one file for the effects-recording digest. `budget` is mutated and
 * SHARED across every file one tool_start/tool_end names, so the aggregate
 * cap is enforced across all of them, never per file alone. Returns
 * `{ status: 'unreadable' }` (never an error state meaning "new file") for a
 * missing path; the caller decides whether a missing BEFORE-read is a new
 * file (fine) or a missing AFTER-read is a failed write (not fine).
 *
 * Security review F1: open, stat and hash all share one fd (O_NOFOLLOW), so
 * nothing re-resolves the path after the open. F1-R2 (low, accepted): the
 * realpath checks above still run before that open, a narrower window.
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
  const resolution = await resolveAgainstWorkspace(filePath, workspaceRoot!);
  if (resolution.escapes) return { status: 'outside_workspace' };
  // Security review F1-R1: re-run the same two checks gateDecision already
  // ran, but against what the path actually resolves to. A symlinked
  // directory alias can make the literal path and the resolved path name
  // two different classes (or git-ness) while neither individual realpath
  // call above looked like an escape.
  if (hasGitSegmentForHashing(resolution.resolvedPath)) return { status: 'outside_workspace' };
  if (!HASHABLE_PATH_CLASSES.has(classifyPathForHashing(resolution.resolvedPath))) return { status: 'credential_class' };

  let fd: number;
  try {
    fd = fs.openSync(filePath, O_NOFOLLOW_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') return { status: 'symlink' };
    return { status: 'unreadable' };
  }

  let st: fs.Stats;
  try {
    st = fs.fstatSync(fd);
  } catch {
    fs.closeSync(fd);
    return { status: 'unreadable' };
  }
  // nlink > 1: a hard link to the same inode under a different, possibly
  // secret-classified, name. The path the client reports is not the only
  // name this content answers to, so it is treated like any other escape.
  if (!st.isFile() || st.nlink > 1) {
    fs.closeSync(fd);
    return { status: 'not_regular_file' };
  }
  if (st.size > MAX_FILE_DIGEST_BYTES || st.size > budget.remainingBytes) {
    fs.closeSync(fd);
    return { status: 'size' };
  }

  try {
    // Security review F5: bound the read to the fstat'd size (end is
    // inclusive) so an append mid-read can never inflate `bytes` past it.
    // autoClose (default true) closes fd once the stream ends or errors;
    // the path argument is required by the type but ignored when fd is set.
    const source: AsyncIterable<Uint8Array> =
      st.size === 0
        ? (async function* () {
            fs.closeSync(fd); // nothing to stream; createReadStream never opens it
          })()
        : fs.createReadStream(filePath, { fd, start: 0, end: st.size - 1, highWaterMark: 64 * 1024 });
    const { hex, bytes } = await hashFileDigest(key, source);
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
