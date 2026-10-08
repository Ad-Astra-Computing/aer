// Effects recording (P0-2): the tool_start/tool_end pairing. A pure async
// planning half (file I/O, no session state) plus a sync apply half (mutates
// the event and the locked state), so file reads stay outside the lock. No
// stable tool_use_id (Antigravity today) means no pairing and no digest.

import { deriveKid } from '@adastracomputing/aer-emit';
import type { HookEvent } from './normalize.js';
import type { SessionState } from './session-store.js';
import { sweepStaleEffectStash } from './session-store.js';
import type { ToolShape } from './tool-shape.js';
import { findWorkspaceRoot, gateDecision, hashBeforeDigest, hashFileForEffectDigest, MAX_AGGREGATE_DIGEST_BYTES } from './effect-digest.js';

type EffectStash = NonNullable<SessionState['effectStash']>;

function stashKey(toolUseId: string, path: string): string {
  return `${toolUseId}::${path}`;
}

function toolUseIdOf(event: HookEvent): string | undefined {
  const v = event.meta?.['tool_use_id'];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export type EffectDigestPlan =
  | { kind: 'none' }
  | { kind: 'tool_start'; keptShapes: ToolShape[]; newEntries: Array<{ key: string; path: string; sha256Before?: string }> }
  | { kind: 'tool_end'; appendShapes: ToolShape[]; consumedKeys: string[] };

/**
 * The async, file-reading half. `stashSnapshot` is a best-effort, possibly
 * stale read of state.effectStash (loaded outside any lock); this function
 * touches no session state itself.
 */
export async function computeEffectDigestPlan(
  event: HookEvent,
  stashSnapshot: EffectStash | undefined,
  key: Buffer | null,
  now: number,
): Promise<EffectDigestPlan> {
  const toolUseId = toolUseIdOf(event);
  if (toolUseId === undefined) return { kind: 'none' };
  const workspaceRoot = findWorkspaceRoot(event.cwd);
  const budget = { remainingBytes: MAX_AGGREGATE_DIGEST_BYTES };

  if (event.kind === 'tool_start') {
    if (key === null || event.shapes === undefined) return { kind: 'none' };
    const keptShapes: ToolShape[] = [];
    const newEntries: Array<{ key: string; path: string; sha256Before?: string }> = [];
    for (const shape of event.shapes) {
      if (shape.eventType !== 'file.written') { keptShapes.push(shape); continue; }
      const path = typeof shape.payload['path'] === 'string' ? shape.payload['path'] : undefined;
      const gate = path !== undefined ? gateDecision(path, workspaceRoot) : { hashable: false as const };
      if (path === undefined || !gate.hashable) { keptShapes.push(shape); continue; }
      const sha256Before = await hashBeforeDigest(path, workspaceRoot, key, budget);
      newEntries.push({ key: stashKey(toolUseId, path), path, ...(sha256Before !== undefined ? { sha256Before } : {}) });
    }
    if (newEntries.length === 0) return { kind: 'none' };
    return { kind: 'tool_start', keptShapes, newEntries };
  }

  if (event.kind === 'tool_end') {
    if (stashSnapshot === undefined) return { kind: 'none' };
    const prefix = `${toolUseId}::`;
    const appendShapes: ToolShape[] = [];
    const consumedKeys: string[] = [];
    for (const [k, entry] of Object.entries(stashSnapshot)) {
      if (!k.startsWith(prefix)) continue;
      consumedKeys.push(k);
      if (key === null) continue; // the entry is simply consumed; no digest to compute
      const outcome = await hashFileForEffectDigest(entry.path, workspaceRoot, key, budget);
      const payload: Record<string, unknown> = { path: entry.path, hash_status: outcome.status };
      if (outcome.status === 'ok') {
        if (entry.sha256Before !== undefined) payload['sha256_before'] = entry.sha256Before;
        payload['sha256_after'] = outcome.sha256;
        payload['bytes'] = outcome.bytes;
        payload['kid'] = deriveKid(key);
      }
      appendShapes.push({ eventType: 'file.written', payload });
    }
    if (consumedKeys.length === 0) return { kind: 'none' };
    return { kind: 'tool_end', appendShapes, consumedKeys };
  }

  return { kind: 'none' };
}

/**
 * The sync, state-mutating half. Applied inside the SAME locked
 * read-modify-write section as every other session-store change, so a
 * concurrent invocation never races the stash. Mutates `event` and `state`
 * in place; also runs the TTL/cap sweep so a plan that adds entries leaves
 * the stash in a consistent, bounded state before the lock releases.
 */
export function applyEffectDigestPlan(event: HookEvent, state: SessionState, plan: EffectDigestPlan, now: number): void {
  if (plan.kind === 'none') return;

  if (plan.kind === 'tool_start') {
    event.shapes = plan.keptShapes;
    const stash = { ...(state.effectStash ?? {}) };
    for (const e of plan.newEntries) stash[e.key] = { path: e.path, stashedAt: now, ...(e.sha256Before !== undefined ? { sha256Before: e.sha256Before } : {}) };
    state.effectStash = stash;
    sweepStaleEffectStash(state, now);
    return;
  }

  // tool_end
  if (state.effectStash !== undefined) {
    const next = { ...state.effectStash };
    for (const k of plan.consumedKeys) delete next[k];
    if (Object.keys(next).length === 0) delete state.effectStash;
    else state.effectStash = next;
  }
  if (plan.appendShapes.length > 0) event.effectShapes = plan.appendShapes;
}
