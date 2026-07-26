// opencode plugin factory — wires the opencode normalizers to the AER emit sink.
//
// opencode loads this in-process and long-lived (one plugin instance for the whole
// run), so unlike the shell-hook path (a fresh process per event) we keep ONE AER
// session sink per opencode session in memory: open lazily on first activity, emit
// tool events across the session, complete on session.deleted or plugin dispose.
//
// FAIL-OPEN: every hook is wrapped so a sink or mapping error can never break or
// slow opencode. Emission itself is already best-effort in the sink.

import { createHttpSink, resolveSinkOptionsFromEnv, type EventSink, type HttpSinkOptions } from '@adastracomputing/aer-emit';
import { emitHookEvent } from './core.js';
import {
  normalizeOpencodeToolBefore,
  normalizeOpencodeToolAfter,
  normalizeOpencodeEvent,
  normalizeOpencodeMessage,
  type OpencodeToolBeforeInput,
  type OpencodeToolBeforeOutput,
  type OpencodeToolAfterInput,
  type OpencodeToolAfterOutput,
  type OpencodeLlm,
} from './opencode.js';

// Structural subset of opencode's `Hooks` we implement. Typed here (rather than
// importing @opencode-ai/plugin) so aer-hooks carries no opencode dependency; the
// returned object is still accepted by opencode via structural typing.
export interface OpencodeHooks {
  'tool.execute.before'?: (input: OpencodeToolBeforeInput, output: OpencodeToolBeforeOutput) => Promise<void>;
  'tool.execute.after'?: (input: OpencodeToolAfterInput, output: OpencodeToolAfterOutput) => Promise<void>;
  event?: (input: { event: unknown }) => Promise<void>;
  dispose?: () => Promise<void>;
}

export interface AerOpencodeDeps {
  /** Resolved sink options (baseUrl, apiKey, tenant/agent/env, fetch). */
  base: HttpSinkOptions;
  /** Injectable sink opener for tests. Defaults to createHttpSink. */
  openSink?: (opts: HttpSinkOptions) => EventSink;
  env?: NodeJS.ProcessEnv;
}

// Sessions with no id (should not happen for real opencode traffic) share one sink.
const SINGLE = '__aer_single__';

/**
 * Build the opencode hooks object. One AER session per opencode session:
 *   tool.execute.before → tool.started (tool + arg KEY names)
 *   tool.execute.after  → tool.completed (tool + ok)
 *   event session.created → open; session.deleted → complete + close that session
 *   dispose → complete + close every still-open session
 * Never throws.
 */
export function createAerOpencodeHooks(deps: AerOpencodeDeps): OpencodeHooks {
  const open = deps.openSink ?? createHttpSink;
  const sinks = new Map<string, EventSink>();
  // Per-session dedup of assistant messages: emit llm.requested once on first
  // sighting, llm.completed once when the message reaches a terminal state. The
  // same message.updated fires many times as the response streams.
  const msgState = new Map<string, { req: Set<string>; done: Set<string> }>();
  // exactOptionalPropertyTypes: only carry env when it was actually provided.
  const envOpt = deps.env !== undefined ? { env: deps.env } : {};

  const ensure = (ref?: string): EventSink => {
    const key = ref ?? SINGLE;
    let sink = sinks.get(key);
    if (!sink) {
      sink = open({ ...deps.base });
      sinks.set(key, sink);
    }
    return sink;
  };

  const closeOne = async (ref?: string): Promise<void> => {
    const key = ref ?? SINGLE;
    msgState.delete(key);
    const sink = sinks.get(key);
    if (!sink) return;
    sinks.delete(key);
    try { await sink.close(); } catch { /* best-effort complete */ }
  };

  // Emit llm.requested/llm.completed from an assistant message, deduped by id.
  // Model is required by the API's EventSchema for both event types, so a message
  // without one is skipped (opencode always sets modelID on assistant messages).
  const emitLlm = (llm: OpencodeLlm): void => {
    if (llm.model === undefined) return;
    const key = llm.sessionRef ?? SINGLE;
    let st = msgState.get(key);
    if (!st) { st = { req: new Set(), done: new Set() }; msgState.set(key, st); }
    const sink = ensure(llm.sessionRef);
    if (!st.req.has(llm.messageId)) {
      st.req.add(llm.messageId);
      const payload: Record<string, unknown> = { model: llm.model };
      if (llm.provider !== undefined) payload['provider'] = llm.provider;
      void sink.emit('llm.requested', payload);
    }
    if (llm.complete && !st.done.has(llm.messageId)) {
      st.done.add(llm.messageId);
      // opencode streams responses, so streaming:true. Token COUNTS only (bodies-off).
      const payload: Record<string, unknown> = { model: llm.model, ok: llm.ok, streaming: true };
      if (llm.provider !== undefined) payload['provider'] = llm.provider;
      if (llm.inputTokens !== undefined) payload['input_tokens'] = llm.inputTokens;
      if (llm.outputTokens !== undefined) payload['output_tokens'] = llm.outputTokens;
      void sink.emit('llm.completed', payload);
    }
  };

  return {
    'tool.execute.before': async (input, output) => {
      try {
        const ev = normalizeOpencodeToolBefore(input, output);
        // raw enables opt-in arg-VALUE capture under AER_HOOK_RECORD_ARGS, exactly
        // as the shell-hook path does (core.ts reads raw.tool_input).
        emitHookEvent(ev, ensure(ev.sessionRef), { raw: { tool_input: output?.args }, ...envOpt });
      } catch { /* fail open */ }
    },
    'tool.execute.after': async (input, output) => {
      try {
        const ev = normalizeOpencodeToolAfter(input, output);
        emitHookEvent(ev, ensure(ev.sessionRef), { ...envOpt });
      } catch { /* fail open */ }
    },
    event: async ({ event }) => {
      try {
        // message.updated carries LLM model + token usage (never session lifecycle).
        const llm = normalizeOpencodeMessage(event);
        if (llm) { emitLlm(llm); return; }
        const ev = normalizeOpencodeEvent(event);
        if (ev.kind === 'other') return;
        emitHookEvent(ev, ensure(ev.sessionRef), { ...envOpt });
        if (ev.kind === 'session_end') await closeOne(ev.sessionRef);
      } catch { /* fail open */ }
    },
    dispose: async () => {
      const live = [...sinks.values()];
      sinks.clear();
      msgState.clear();
      await Promise.all(live.map((s) => s.close().catch(() => undefined)));
    },
  };
}

/**
 * Ready-to-use opencode Plugin. Resolves AER sink options from the environment
 * (AER_BASE_URL + AER_API_KEY/AER_TENANT_API_KEY + AER_TENANT_ID/AER_AGENT_ID/
 * AER_ENV_ID). When emit is unconfigured it returns empty hooks — a total no-op,
 * so a misconfigured install never touches the network or affects opencode.
 *
 * Drop into `.opencode/plugins/aer.ts` (or a published package) as:
 *   import { aerOpencodePlugin } from '@adastracomputing/aer-hooks';
 *   export const AerPlugin = aerOpencodePlugin;
 * The opencode `PluginInput` is ignored — AER binds its session from env config,
 * not opencode's client.
 */
export async function aerOpencodePlugin(
  _input?: unknown,
  _options?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OpencodeHooks> {
  const base = resolveSinkOptionsFromEnv(env);
  if (!base) return {};
  return createAerOpencodeHooks({ base, env });
}
