// Map a normalized HookEvent to AER event types and emit it. Never throws.
//
// Redaction always: the emitted payload carries the tool name, argument KEY
// names and result flags only, never argument values or result content. Every
// payload is filtered through the ingest allowlist before it is handed to the
// sink, so a key ingest would discard never reaches the wire in the first
// place.

import type { EventSink } from '@adastracomputing/aer-emit';
import type { HookEvent } from './normalize.js';
import type { ToolShape } from './tool-shape.js';
import { stripToIngestPayload } from './shared/ingest-allowlist.js';
import { MAX_APPROVAL_TRACKING_ENTRIES } from './session-store.js';

/**
 * The subset of SessionState emitHookEvent needs for the oversight-markers
 * correlation (P0-1): read/write access to the open-call digests and the
 * pending-approval queue. A plain object literal satisfies this for tests
 * that do not care about persistence; the real caller (cli.ts) passes the
 * actual SessionState, which structurally satisfies it.
 */
export interface ApprovalCorrelationState {
  openCalls?: Record<string, { callDigest: string; openedAt: number }>;
  /**
   * Each entry carries `pushedAt` (build-review fix 4) so the FIFO fallback
   * can require the single open call to have been opened no later than the
   * request was pushed: a request always follows its own PreToolUse, so an
   * open call that started AFTER this pending entry cannot be the call it
   * belongs to, and must not be paired with it.
   */
  pendingApprovals?: Array<{ id: string; pushedAt: number }>;
  pendingApprovalSeq?: number;
  approvalsUnresolved?: number;
}

/**
 * A tool event with no tool name is rejected by ingest, because the name is
 * the whole content of it. Record the call as unnamed rather than send
 * something that will be discarded and take the call with it.
 */
function unnamedTool(send: (type: string, extra: Record<string, unknown>) => void): number {
  send('collector.report', { collector: 'aer-hooks', phase: 'tool_unnamed' });
  return 1;
}

/** Every shape a tool start reduces to; an event built before `shapes` existed carries only `shape`. */
export function shapesOf(event: HookEvent): ToolShape[] {
  if (event.shapes !== undefined) return event.shapes;
  return event.shape !== undefined ? [event.shape] : [];
}

/**
 * Hand one payload to the sink, minus anything ingest would drop. Filtering
 * here rather than trusting the server keeps the privacy claim true on the
 * wire and not just in the database.
 */
function emitFiltered(sink: EventSink, type: string, payload: Record<string, unknown>): void {
  const { payload: safe } = stripToIngestPayload(payload);
  void sink.emit(type, safe);
}

// Oversight markers (P0-1): identity-first approval correlation (see
// scratchpad/reviews/aer-oversight-design.md, "Correlation, revised").
// PermissionRequest drops tool_use_id on this build but carries the same
// tool_name + tool_input as the preceding PreToolUse, so a digest match
// recovers the real id rather than a queue-position guess; a narrow
// single-open-call FIFO fallback covers only an upstream hook rewrite.

function evictOldest<T extends { openedAt: number }>(map: Record<string, T>, cap: number): Record<string, T> {
  const entries = Object.entries(map);
  if (entries.length <= cap) return map;
  entries.sort((a, b) => a[1].openedAt - b[1].openedAt);
  return Object.fromEntries(entries.slice(entries.length - cap));
}

/** PreToolUse: remember this call's digest so a later PermissionRequest can recover its real id. */
function recordOpenCall(state: ApprovalCorrelationState, toolUseId: string | undefined, digest: string | undefined, now: number): void {
  if (toolUseId === undefined || digest === undefined) return;
  const openCalls = { ...(state.openCalls ?? {}), [toolUseId]: { callDigest: digest, openedAt: now } };
  state.openCalls = evictOldest(openCalls, MAX_APPROVAL_TRACKING_ENTRIES);
}

/** tool_end (any outcome): the call closed, its digest is no longer needed. */
function closeOpenCall(state: ApprovalCorrelationState, toolUseId: string | undefined): void {
  if (toolUseId === undefined || state.openCalls === undefined) return;
  if (!(toolUseId in state.openCalls)) return;
  const { [toolUseId]: _removed, ...rest } = state.openCalls;
  state.openCalls = rest;
}

function pushPendingApproval(state: ApprovalCorrelationState, id: string, now: number): void {
  const next = [...(state.pendingApprovals ?? []), { id, pushedAt: now }];
  state.pendingApprovals = next.length > MAX_APPROVAL_TRACKING_ENTRIES
    ? next.slice(next.length - MAX_APPROVAL_TRACKING_ENTRIES)
    : next;
}

/**
 * PermissionRequest: prefer a harness-supplied tool_use_id when the payload
 * carries one (build-review fix 3 — Codex's docs say it can; using it
 * directly, rather than falling through to digest recovery, avoids a false
 * `unid:` whenever Codex's PermissionRequest and tool_start shapes diverge
 * enough that the digest would not match even though the real id is right
 * there). Otherwise recover the real id by digest match against openCalls
 * (exactly one match), or push a synthetic placeholder when zero or more
 * than one call shares that digest — but NOT the same placeholder for both:
 * a zero-match (`unid:<n>`) means no PreToolUse was ever seen for this
 * call at all, which is the only shape the narrow single-open-call FIFO
 * fallback is sound for; a multi-match (`ambig:<n>`) means two or more real
 * open calls share this exact content, and must never become eligible for
 * that fallback, even after enough of them close that only one remains —
 * discovered while testing fix 4: without this split, two calls sharing a
 * digest would resolve correctly only while both stayed open, then
 * silently start guessing the moment the first one closed.
 */
function handlePermissionRequest(state: ApprovalCorrelationState, toolUseId: string | undefined, digest: string | undefined, now: number): void {
  if (toolUseId !== undefined) {
    pushPendingApproval(state, toolUseId, now);
    return;
  }
  if (digest !== undefined) {
    const matches = Object.entries(state.openCalls ?? {}).filter(([, v]) => v.callDigest === digest);
    if (matches.length === 1) {
      pushPendingApproval(state, matches[0]![0], now);
      return;
    }
    if (matches.length > 1) {
      state.pendingApprovalSeq = (state.pendingApprovalSeq ?? 0) + 1;
      pushPendingApproval(state, `ambig:${state.pendingApprovalSeq}`, now);
      return;
    }
  }
  state.pendingApprovalSeq = (state.pendingApprovalSeq ?? 0) + 1;
  pushPendingApproval(state, `unid:${state.pendingApprovalSeq}`, now);
}

/**
 * PermissionDenied: resolve the matching pending entry by EXACT tool_use_id
 * ONLY if this payload happens to carry one (never observed firing on Claude
 * Code's probe; specified from Codex's docs). No digest recovery here: a
 * denial payload was never captured with enough shared fields to test. When
 * it cannot be identified, the entry is left for the turn_end sweep rather
 * than guessed at.
 */
function resolvePermissionDenied(state: ApprovalCorrelationState, toolUseId: string | undefined): boolean {
  if (toolUseId === undefined) return false;
  const pending = state.pendingApprovals ?? [];
  const idx = pending.findIndex((e) => e.id === toolUseId);
  if (idx === -1) return false;
  state.pendingApprovals = [...pending.slice(0, idx), ...pending.slice(idx + 1)];
  return true;
}

type ToolEndResolution = 'allowed' | 'unresolved' | 'none';

// tool_end: exact tool_use_id match, else the narrow single-open-call
// `unid:` FIFO fallback (never `ambig:`), gated by request timing and by
// `openCallsMayBeIncomplete`; `toolEndHook` decides the unresolved hedge.
function resolveToolEnd(
  state: ApprovalCorrelationState,
  toolUseId: string | undefined,
  toolEndHook: 'completed' | 'failure' | undefined,
  openCallsMayBeIncomplete: boolean,
): ToolEndResolution {
  const pending = state.pendingApprovals ?? [];
  let idx = toolUseId !== undefined ? pending.findIndex((e) => e.id === toolUseId) : -1;
  if (idx === -1 && !openCallsMayBeIncomplete) {
    const openEntries = Object.values(state.openCalls ?? {});
    const unidIdx = pending.findIndex((e) => e.id.startsWith('unid:'));
    if (unidIdx !== -1 && openEntries.length === 1 && openEntries[0]!.openedAt <= pending[unidIdx]!.pushedAt) {
      idx = unidIdx;
    }
  }
  if (idx === -1) return 'none';
  // A FIFO match with no tool_use_id on this tool_end must not consume the
  // entry (fix A): approval.decided requires the id, and consuming it here
  // would count it nowhere. Leave it pending for the next sweep instead.
  if (toolUseId === undefined) return 'none';
  state.pendingApprovals = [...pending.slice(0, idx), ...pending.slice(idx + 1)];
  if (toolEndHook === 'failure') {
    // From PostToolUseFailure: [docs, not probed]. The probe never observed a
    // resolved pending entry followed by PostToolUseFailure; this is
    // plausibly the exact shape a real interactive human denial produces, so
    // it is counted unresolved rather than asserted allowed.
    state.approvalsUnresolved = (state.approvalsUnresolved ?? 0) + 1;
    return 'unresolved';
  }
  return 'allowed';
}

/** turn_end: anything still pending was never resolved. Clear per-turn, not only at session end. */
function sweepTurnEnd(state: ApprovalCorrelationState): void {
  const pending = state.pendingApprovals ?? [];
  if (pending.length > 0) state.approvalsUnresolved = (state.approvalsUnresolved ?? 0) + pending.length;
  state.pendingApprovals = [];
  state.openCalls = {};
}

/**
 * Emit one normalized hook event through the sink. Maps:
 *   tool_start -> tool.started   { tool, arg_keys, tool_use_id }
 *   tool_end   -> tool.completed { tool, ok, is_error, tool_use_id }
 *   every other kind -> collector.report { collector, phase }
 *
 * The harness lifecycle markers are recorded as collector.report phases (a
 * valid EventSchema type) rather than as session.started/ended: the AER
 * session lifecycle is owned by the sink's open + complete, so synthetic
 * lifecycle events would be redundant and could skew the generator's
 * observations. hook_start/hook_end/prompt.submitted are not EventSchema types
 * and the API rejects them per-event.
 *
 * Every payload carries the harness metadata the event came with, so a reader
 * can tell which harness, model and permission mode produced the run without
 * inferring it. Any failure inside the sink is swallowed; this never throws.
 */
export function emitHookEvent(
  event: HookEvent,
  sink: EventSink,
  state: ApprovalCorrelationState = {},
  now: number = Date.now(),
  /** True when this harness session has dropped an event for budget reasons at some point, so openCalls may be missing an entry (confirmation-pass fix B). */
  openCallsMayBeIncomplete = false,
): number {
  try {
    if (event.kind === 'other') return 0;

    const common: Record<string, unknown> = { ...(event.meta ?? {}) };
    if (event.sessionRef !== undefined) common['session_ref'] = event.sessionRef;

    // One invocation can produce more than one event, so the position counts
    // events rather than invocations: a repeated number would read as a
    // duplicate to anyone checking the record for gaps.
    let seq = event.seq;
    let sent = 0;
    const send = (type: string, extra: Record<string, unknown>): void => {
      const payload: Record<string, unknown> = { ...common, ...extra };
      if (seq !== undefined) payload['seq'] = seq++;
      emitFiltered(sink, type, payload);
      sent += 1;
    };

    switch (event.kind) {
      case 'tool_start': {
        recordOpenCall(state, event.meta?.['tool_use_id'] as string | undefined, event.callDigest, now);
        if (event.tool === undefined) return unnamedTool(send);
        const fields: Record<string, unknown> = { tool: event.tool };
        if (event.argKeys !== undefined) fields['arg_keys'] = event.argKeys;
        // A patch naming more files than are recorded says how many it named.
        send('tool.started', event.filesNamed !== undefined ? { ...fields, count: event.filesNamed } : fields);
        // What the call actually did, alongside the fact that it happened.
        // Both go through the same sink, so it is one request either way.
        for (const shape of shapesOf(event)) send(shape.eventType, { ...fields, ...shape.payload });
        return sent;
      }
      case 'tool_end': {
        const toolUseId = event.meta?.['tool_use_id'] as string | undefined;
        // Resolve BEFORE evicting: the single-open-call FIFO fallback needs
        // to see this call still counted among the open ones to judge
        // whether it was the only one.
        const resolution = resolveToolEnd(state, toolUseId, event.toolEndHook, openCallsMayBeIncomplete);
        closeOpenCall(state, toolUseId);
        if (resolution === 'allowed') {
          // tool_use_id/turn_id already ride via `common` (commonMeta already
          // carries both for kind tool_end); `decided_by` is the only new key.
          send('approval.decided', { decision: 'allowed', decided_by: 'prompted' });
        }
        if (event.tool === undefined) return unnamedTool(send);
        const fields: Record<string, unknown> = { tool: event.tool };
        if (event.ok !== undefined) fields['ok'] = event.ok;
        if (event.isError !== undefined) fields['is_error'] = event.isError;
        send('tool.completed', fields);
        return sent;
      }
      case 'permission': {
        if (event.permissionHook === 'request') {
          handlePermissionRequest(state, event.meta?.['tool_use_id'] as string | undefined, event.callDigest, now);
          return sent; // no decision yet
        }
        if (event.permissionHook === 'denied') {
          const toolUseId = event.meta?.['tool_use_id'] as string | undefined;
          // decided_by is 'policy' here, never 'human': see core.ts's module
          // comment and the design doc: [docs, not probed on Claude Code].
          if (resolvePermissionDenied(state, toolUseId)) {
            send('approval.decided', { decision: 'denied', decided_by: 'policy' });
          }
        }
        return sent;
      }
      case 'turn_start': {
        send('human.input', { kind: 'prompt' });
        return sent;
      }
      case 'turn_end': {
        sweepTurnEnd(state);
        send('collector.report', { collector: 'aer-hooks', phase: event.kind });
        return sent;
      }
      case 'session_end': {
        // Build-review fix 2: a pending request open when the session ends
        // (a human quitting at the dialog with no Stop, or any lifecycle-1
        // registration where Stop maps to session_end and no turn_end ever
        // sweeps) must not be silently lost, and must not persist to be
        // wrongly FIFO-paired against a later, unrelated session.
        sweepTurnEnd(state);
        send('collector.report', { collector: 'aer-hooks', phase: event.kind });
        return sent;
      }
      default: {
        // collector.report requires a non-empty `collector`; `phase` rides
        // along via the variant's passthrough() to carry which marker this is.
        send('collector.report', { collector: 'aer-hooks', phase: event.kind });
        return sent;
      }
    }
  } catch {
    /* emit must never throw */
  }
  return 0;
}
