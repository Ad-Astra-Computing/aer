// vcs.pushed (git push outcome + before/after ref): the tool_start/tool_end
// pairing, mirroring effect-digest-plan.ts's async-plan/sync-apply split.
// Scoped to a plain, single-branch `git push [remote] [branch]`; anything
// else recognisably `git push` still gets the event, with outcome 'unknown'
// and no refs. Never blocks the real push: rev-parse calls only read repo
// state before/after it runs, bounded by a tight timeout like cli.ts's `ps`.

import { execFile } from 'node:child_process';
import type { HookEvent } from './normalize.js';
import type { SessionState } from './session-store.js';
import { sweepStaleVcsPushStash } from './session-store.js';
import type { ToolShape } from './tool-shape.js';
import { SHA } from './evidence.js';

type VcsPushStash = NonNullable<SessionState['vcsPushStash']>;

/** Modelled on cli.ts's `ps` calls (same ballpark timeout): this is an
 *  auxiliary read of local repo state, never allowed to hang the hook. */
const REV_PARSE_TIMEOUT_MS = 500;

function toolUseIdOf(event: HookEvent): string | undefined {
  const v = event.meta?.['tool_use_id'];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** The `git push` ProgramLabel shape on this call, if any. Recomputed fresh
 *  from `event.shapes` at both tool_start and tool_end (shapesOfToolCall
 *  already reduces the SAME tool_input at both, same as every other shape),
 *  so tool_end never depends on a stash entry just to know this was a push. */
function gitPushShape(shapes: ToolShape[] | undefined): ToolShape | undefined {
  return shapes?.find((s) => s.eventType === 'process.exec' && s.payload['verb'] === 'git push');
}

function closedSetClasses(shape: ToolShape): Record<string, 'origin' | 'new' | 'protected' | 'other'> {
  const remoteClass = shape.payload['remote_class'];
  const branchClass = shape.payload['branch_class'];
  const out: Record<string, 'origin' | 'new' | 'protected' | 'other'> = {};
  if (remoteClass === 'origin' || remoteClass === 'new') out['remote_class'] = remoteClass;
  if (branchClass === 'protected' || branchClass === 'other') out['branch_class'] = branchClass;
  return out;
}

/** One `git rev-parse <ref>` call, bounded and validated: never throws, and
 *  resolves to a value only when stdout, trimmed, is a bare 40/64-hex id.
 *  Every other exit (error, timeout, a tag name, empty output, a second
 *  line) resolves to `undefined`, the raw output is never forwarded. */
export function revParse(ref: string, cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(
        'git',
        ['rev-parse', '--verify', '--quiet', ref],
        { cwd, timeout: REV_PARSE_TIMEOUT_MS, encoding: 'utf8' },
        (err, stdout) => {
          if (err) { resolve(undefined); return; }
          const trimmed = typeof stdout === 'string' ? stdout.trim() : '';
          resolve(SHA.test(trimmed) ? trimmed : undefined);
        },
      );
    } catch {
      resolve(undefined);
    }
  });
}

function outcomeOf(isError: boolean | undefined): 'accepted' | 'rejected' | 'unknown' {
  if (isError === true) return 'rejected';
  if (isError === false) return 'accepted';
  return 'unknown';
}

export type VcsPushPlan =
  | { kind: 'none' }
  | { kind: 'tool_start'; key: string; beforeRef?: string }
  | { kind: 'tool_end'; appendShape: ToolShape; consumedKey?: string };

/** Injectable for tests (same DI pattern as root-session-join.test.ts's
 *  `parentPidOf`): the real git call, or a rigged stand-in. */
export interface VcsPushDeps {
  revParse?: (ref: string, cwd: string) => Promise<string | undefined>;
}

/**
 * The async, subprocess-calling half. `stashSnapshot` is a best-effort,
 * possibly stale read of state.vcsPushStash (loaded outside any lock, same
 * as effect-digest-plan.ts's `probe`); this function touches no session
 * state itself. `cwdFallback` covers an event with no cwd of its own.
 */
export async function computeVcsPushPlan(
  event: HookEvent,
  stashSnapshot: VcsPushStash | undefined,
  cwdFallback: string,
  now: number,
  deps: VcsPushDeps = {},
): Promise<VcsPushPlan> {
  const toolUseId = toolUseIdOf(event);
  if (toolUseId === undefined) return { kind: 'none' };
  const cwd = event.cwd ?? cwdFallback;
  const doRevParse = deps.revParse ?? revParse;

  if (event.kind === 'tool_start') {
    const shape = gitPushShape(event.shapes);
    if (shape === undefined) return { kind: 'none' };
    const target = event.vcsPushTarget;
    if (target === undefined) {
      // Not a single resolvable branch (bare push, remote-only, --all/
      // --mirror/--tags/--delete, multi-refspec, a colon form): nothing to
      // stash. tool_end recomputes the same thing from its own tool_input
      // and degrades to outcome 'unknown' with no refs; no before_ref
      // attempt is made here because there is no single ref to ask for.
      return { kind: 'none' };
    }
    const beforeRef = await doRevParse(`refs/remotes/${target.remote}/${target.branch}`, cwd);
    // beforeRef can legitimately be undefined here (a brand-new local
    // branch's first push has no remote-tracking ref yet); stashing nothing
    // is fine, tool_end's reflog fallback is what covers that case, not this
    // entry.
    return beforeRef !== undefined ? { kind: 'tool_start', key: toolUseId, beforeRef } : { kind: 'none' };
  }

  if (event.kind === 'tool_end') {
    const shape = gitPushShape(event.shapes);
    if (shape === undefined) return { kind: 'none' };
    const classes = closedSetClasses(shape);
    const consumedKey = stashSnapshot?.[toolUseId] !== undefined ? toolUseId : undefined;
    const target = event.vcsPushTarget;

    if (target === undefined) {
      // Same unresolvable-argv case as tool_start: record that a push
      // happened (outcome, and whatever classes labelGit could set), but no
      // ref the design review did not want guessed at.
      return { kind: 'tool_end', appendShape: { eventType: 'vcs.pushed', payload: { outcome: 'unknown', ...classes } }, ...(consumedKey !== undefined ? { consumedKey } : {}) };
    }

    const afterRef = await doRevParse(target.branch, cwd);
    const outcome = outcomeOf(event.isError);
    // Reflog fallback (no tool_start stash entry): `@{1}` is only correct
    // once this push has actually moved the remote-tracking ref, so try its
    // current value first and fall back to `@{1}` only when that already
    // equals afterRef on an accepted push.
    const stashedBefore = stashSnapshot?.[toolUseId]?.beforeRef;
    let beforeRef = stashedBefore;
    if (beforeRef === undefined) {
      const currentRemoteRef = await doRevParse(`refs/remotes/${target.remote}/${target.branch}`, cwd);
      beforeRef = outcome === 'accepted' && currentRemoteRef !== undefined && currentRemoteRef === afterRef
        ? await doRevParse(`${target.remote}/${target.branch}@{1}`, cwd)
        : currentRemoteRef;
    }

    const payload: Record<string, unknown> = { outcome, ...classes };
    // Judgment call, flag for review: a rejected push still gets both refs
    // when they resolve, since they are plain local reads, not a claim the
    // remote now holds after_ref (that claim is what `outcome` carries). An
    // equally defensible alternative is to omit after_ref on a rejection.
    if (beforeRef !== undefined) payload['before_ref'] = beforeRef;
    if (afterRef !== undefined) payload['after_ref'] = afterRef;

    return { kind: 'tool_end', appendShape: { eventType: 'vcs.pushed', payload }, ...(consumedKey !== undefined ? { consumedKey } : {}) };
  }

  return { kind: 'none' };
}

/** The sync, state-mutating half, applied inside the same locked
 *  read-modify-write section as every other session-store change, mirroring
 *  applyEffectDigestPlan. Appends to `event.effectShapes` (the field
 *  effects-recording already uses), so core.ts needs no change to keep its
 *  "sent only at tool_end, never alongside shapes" rule. */
export function applyVcsPushPlan(event: HookEvent, state: SessionState, plan: VcsPushPlan, now: number): void {
  if (plan.kind === 'none') return;

  if (plan.kind === 'tool_start') {
    const stash = { ...(state.vcsPushStash ?? {}) };
    stash[plan.key] = { stashedAt: now, ...(plan.beforeRef !== undefined ? { beforeRef: plan.beforeRef } : {}) };
    state.vcsPushStash = stash;
    sweepStaleVcsPushStash(state, now);
    return;
  }

  // tool_end
  if (plan.consumedKey !== undefined && state.vcsPushStash !== undefined) {
    const next = { ...state.vcsPushStash };
    delete next[plan.consumedKey];
    if (Object.keys(next).length === 0) delete state.vcsPushStash;
    else state.vcsPushStash = next;
  }
  event.effectShapes = [...(event.effectShapes ?? []), plan.appendShape];
}
