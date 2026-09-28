// Vercel AI SDK, instrumented one layer below the facade.
//
// `ai`'s module namespace is sealed, so generateText and streamText cannot be
// wrapped in place. The provider packages underneath are ordinary classes with
// extensible prototypes, and one call to a model's doGenerate is one real
// model call, which is the unit a record should carry anyway.

import type { CollectorEvent } from '../session.js';
import type { AdapterInstall, ProtoTarget } from './resolve.js';
import { loadModuleCopies } from './resolve.js';
import { patchMethod, toolNameToRecord, resolvePolicy, gateBeforeCall, accountAfterCall, settleBy, type PolicyOption, type PolicyOptionSource } from './llm-core.js';
import type { AdapterStats } from './stats.js';

type Capture = (event: CollectorEvent) => void;

/** Provider packages we know how to reach, and the factory each exports. */
const PROVIDERS: ReadonlyArray<{ pkg: string; factory: string; provider: string }> = [
  { pkg: '@ai-sdk/openai', factory: 'createOpenAI', provider: 'openai' },
  { pkg: '@ai-sdk/anthropic', factory: 'createAnthropic', provider: 'anthropic' },
  { pkg: '@ai-sdk/google', factory: 'createGoogleGenerativeAI', provider: 'google' },
  { pkg: '@ai-sdk/mistral', factory: 'createMistral', provider: 'mistral' },
  { pkg: '@ai-sdk/groq', factory: 'createGroq', provider: 'groq' },
];

// One provider exposes several model classes (chat, responses, completion),
// and a call can land on any of them.
const MODEL_FACTORIES = ['chat', 'responses', 'completion', 'languageModel'] as const;

/** Never a real credential: the factory only stores it, and no call is made. */
const PROBE_KEY = 'aer-probe-not-a-key';
const PROBE_MODEL = 'aer-probe-model';

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * A token count. The v4 provider spec reports `{ total, noCache, ... }` where
 * earlier versions reported a bare number, so both are read.
 */
export function tokenCount(v: unknown): number | undefined {
  const direct = num(v);
  if (direct !== undefined) return direct;
  if (typeof v !== 'object' || v === null) return undefined;
  return num((v as Record<string, unknown>)['total']);
}

/** A finish reason. v4 reports `{ unified, raw }`; earlier versions a string. */
export function finishReasonOf(v: unknown): string | undefined {
  const direct = str(v);
  if (direct !== undefined) return direct;
  if (typeof v !== 'object' || v === null) return undefined;
  const rec = v as Record<string, unknown>;
  return str(rec['unified']) ?? str(rec['raw']);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Model prototypes reachable from one loaded provider module. */
function protosOf(mod: unknown, factoryName: string): ProtoTarget[] {
  const out: ProtoTarget[] = [];
  const m = mod as Record<string, unknown> | null;
  const factory = m?.[factoryName];
  if (typeof factory !== 'function') return out;

  let provider: unknown;
  try {
    provider = (factory as (o: unknown) => unknown)({ apiKey: PROBE_KEY });
  } catch {
    return out;
  }

  const candidates: unknown[] = [];
  const build = (fn: unknown): void => {
    if (typeof fn !== 'function') return;
    try { candidates.push((fn as (id: string) => unknown)(PROBE_MODEL)); } catch { /* not a model factory */ }
  };
  build(provider);
  for (const key of MODEL_FACTORIES) build((provider as Record<string, unknown>)?.[key]);

  for (const model of candidates) {
    if (typeof model !== 'object' || model === null) continue;
    const proto = Object.getPrototypeOf(model) as ProtoTarget | null;
    if (!proto || typeof proto['doGenerate'] !== 'function') continue;
    if (!out.includes(proto)) out.push(proto);
  }
  return out;
}

/**
 * Patch doGenerate (and doStream) on every provider model class installed.
 * Async because the provider packages have to be loaded from the app.
 */
export async function installVercelProviderAdapter(
  capture: Capture,
  stats?: AdapterStats,
  policy?: PolicyOptionSource,
): Promise<AdapterInstall> {
  const uninstalls: Array<() => void> = [];

  for (const { pkg, factory, provider } of PROVIDERS) {
    try {
      for (const mod of await loadModuleCopies(pkg)) {
        for (const proto of protosOf(mod, factory)) {
          const gen = patchMethod(
            proto, 'doGenerate',
            (orig) => wrapModelCall(orig, provider, capture, stats, false, policy),
            `vercel-provider.${provider}.doGenerate`,
          );
          if (gen) uninstalls.push(gen);
          const stream = patchMethod(
            proto, 'doStream',
            (orig) => wrapModelCall(orig, provider, capture, stats, true, policy),
            `vercel-provider.${provider}.doStream`,
          );
          if (stream) uninstalls.push(stream);
        }
      }
    } catch {
      // A provider we cannot reach records nothing and breaks nothing.
    }
  }

  return {
    enabled: uninstalls.length > 0,
    uninstall: () => { for (const u of uninstalls) { try { u(); } catch { /* best-effort */ } } },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

/** What a finished call carries: usage, finish reason and tool NAMES only. */
interface CallMeta {
  input_tokens?: number;
  output_tokens?: number;
  stop_reason?: string;
  model?: string;
  tool_names: string[];
}

/** Tool names from a doGenerate result's content parts. Never the input. */
export function toolNamesOf(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const part of content) {
    const rec = part as Record<string, unknown> | null;
    if (rec?.['type'] !== 'tool-call') continue;
    const name = str(rec['toolName']);
    if (name !== undefined) out.push(name);
  }
  return out;
}

function metaOfResult(value: unknown): CallMeta {
  const v = value as Record<string, unknown> | undefined;
  const usage = v?.['usage'] as Record<string, unknown> | undefined;
  const meta: CallMeta = { tool_names: toolNamesOf(v?.['content']) };
  const input = tokenCount(usage?.['inputTokens']);
  const output = tokenCount(usage?.['outputTokens']);
  if (input !== undefined) meta.input_tokens = input;
  if (output !== undefined) meta.output_tokens = output;
  const stop = finishReasonOf(v?.['finishReason']);
  if (stop !== undefined) meta.stop_reason = stop;
  // The response can name a more specific model than the request asked for.
  const responded = str((v?.['response'] as Record<string, unknown> | undefined)?.['modelId']);
  if (responded !== undefined) meta.model = responded;
  return meta;
}

/**
 * Fold one stream part into the running metadata. Reads the part TYPE, the
 * finish part's usage and reason, a tool-call's NAME and the response model
 * id. Never a text delta, a tool input or any other content.
 */
export function foldStreamPart(part: unknown, meta: CallMeta): 'error' | undefined {
  const rec = part as Record<string, unknown> | null;
  const type = rec?.['type'];
  if (type === 'tool-call') {
    const name = str(rec?.['toolName']);
    if (name !== undefined) meta.tool_names.push(name);
  } else if (type === 'finish') {
    const usage = rec?.['usage'] as Record<string, unknown> | undefined;
    const input = tokenCount(usage?.['inputTokens']);
    const output = tokenCount(usage?.['outputTokens']);
    if (input !== undefined) meta.input_tokens = input;
    if (output !== undefined) meta.output_tokens = output;
    const stop = finishReasonOf(rec?.['finishReason']);
    if (stop !== undefined) meta.stop_reason = stop;
  } else if (type === 'response-metadata') {
    const model = str(rec?.['modelId']);
    if (model !== undefined) meta.model = model;
  } else if (type === 'error') {
    return 'error';
  }
  return undefined;
}

/**
 * Put a pass-through stream in place of `result.stream` that records the call
 * when the host finishes reading it. It pulls from the provider only when the
 * host pulls from it, so it never reads ahead or changes backpressure, and it
 * hands every part on unchanged. `onEnd` runs exactly once: with the metadata
 * when the stream ends or the host cancels it, with null when it errors.
 * Returns false when the result has no stream it can replace.
 */
export function tapResultStream(
  result: unknown,
  onEnd: (meta: CallMeta | null) => void,
): boolean {
  const rec = result as Record<string, unknown> | null;
  const source = rec?.['stream'] as ReadableStream<unknown> | undefined;
  if (!source || typeof (source as { getReader?: unknown }).getReader !== 'function') return false;

  const meta: CallMeta = { tool_names: [] };
  let errored = false;
  let ended = false;
  const end = (failed: boolean): void => {
    if (ended) return;
    ended = true;
    try { onEnd(failed || errored ? null : meta); } catch { /* never break the host */ }
  };

  let reader: ReadableStreamDefaultReader<unknown>;
  try {
    reader = source.getReader();
  } catch {
    return false;
  }
  const tapped = new ReadableStream<unknown>({
    async pull(controller) {
      let r: Awaited<ReturnType<typeof reader.read>>;
      try {
        r = await reader.read();
      } catch (err) {
        end(true);
        controller.error(err);
        return;
      }
      if (r.done) {
        end(false);
        controller.close();
        return;
      }
      try { if (foldStreamPart(r.value, meta) === 'error') errored = true; } catch { /* metadata is best-effort */ }
      controller.enqueue(r.value);
    },
    async cancel(reason) {
      // The host stopped reading. Whatever was observed is what happened;
      // an abort surfaces as an error part or a read error, not here.
      end(false);
      await reader.cancel(reason);
    },
  }, { highWaterMark: 0 });

  try {
    rec!['stream'] = tapped;
    if (rec!['stream'] !== tapped) throw new Error('read-only');
  } catch {
    // Could not swap it in: hand the original back untouched.
    try { reader.releaseLock(); } catch { /* already released */ }
    return false;
  }
  return true;
}

/**
 * Wrap one model call. The LanguageModel spec is uniform across providers:
 * the model id is on the instance, doGenerate resolves with usage, a finish
 * reason and content parts, and doStream resolves with a stream whose finish
 * part carries the same. Nothing here reads the prompt, the generated text or
 * a tool input.
 */
export function wrapModelCall(
  original: AnyFn,
  provider: string,
  capture: Capture,
  stats: AdapterStats | undefined,
  streaming: boolean,
  policySource?: PolicyOptionSource,
): AnyFn {
  return function wrapped(this: unknown, ...args: unknown[]): unknown {
    const self = this;
    const model = str((self as Record<string, unknown> | null)?.['modelId']);
    const first = resolvePolicy(policySource);
    // Only a call that races the process's first policy fetch can see
    // `ready`; it waits for that fetch, never past its fixed bound. Both
    // methods return a promise by spec, so the wait changes nothing the host
    // relies on. Once any answer is known nothing waits.
    if (first?.ready && first.waitUntil !== undefined) {
      return settleBy(first.ready, first.waitUntil)
        .then(() => call(self, args, model, resolvePolicy(policySource)));
    }
    return call(self, args, model, first);
  };

  function call(self: unknown, args: unknown[], model: string | undefined, policy: PolicyOption | undefined): unknown {
    // Throws AerPolicyError in block mode, before the provider is reached.
    gateBeforeCall(policy, model);

    const base: Record<string, unknown> = { provider, ...(model !== undefined ? { model } : {}) };
    try {
      capture({ event_type: 'llm.requested', payload: { ...base, streaming } });
      stats?.record(provider, 'call');
    } catch { /* never break the call */ }

    const finish = (meta: CallMeta | null): void => {
      safeComplete(capture, stats, provider, base, meta, streaming);
      if (meta) accountAfterCall(policy, meta.input_tokens, meta.output_tokens);
    };

    let result: unknown;
    try {
      result = original.apply(self, args);
    } catch (err) {
      finish(null);
      throw err;
    }

    const settle = (value: unknown): void => {
      if (!streaming) { finish(metaOfResult(value)); return; }
      // A stream resolves before its tokens exist. The counts arrive in the
      // finish part, so the call is recorded when the host has read it.
      if (!tapResultStream(value, finish)) finish({ tool_names: [] });
    };

    if (result instanceof Promise || (typeof result === 'object' && result !== null && typeof (result as PromiseLike<unknown>).then === 'function')) {
      return (result as Promise<unknown>).then(
        (value) => { settle(value); return value; },
        (err: unknown) => { finish(null); throw err; },
      );
    }
    settle(result);
    return result;
  }
}

function safeComplete(
  capture: Capture,
  stats: AdapterStats | undefined,
  provider: string,
  base: Record<string, unknown>,
  meta: CallMeta | null,
  streaming: boolean,
): void {
  try {
    const ok = meta !== null;
    const payload: Record<string, unknown> = { ...base, ok };
    if (!ok) payload['error'] = true;
    if (streaming) {
      payload['streaming'] = true;
      if (ok) payload['usage_observed'] = meta.input_tokens !== undefined || meta.output_tokens !== undefined;
    }
    if (meta?.input_tokens !== undefined) payload['input_tokens'] = meta.input_tokens;
    if (meta?.output_tokens !== undefined) payload['output_tokens'] = meta.output_tokens;
    if (meta?.stop_reason !== undefined) payload['stop_reason'] = meta.stop_reason;
    if (meta?.model !== undefined) payload['model'] = meta.model;

    capture({ event_type: 'llm.completed', payload });
    stats?.record(provider, ok ? 'ok' : 'error');
    for (const tool of meta?.tool_names ?? []) {
      capture({ event_type: 'tool.selected', payload: { provider, tool: toolNameToRecord(tool, provider, stats) } });
      stats?.record(provider, 'tool');
    }
  } catch { /* never break the call */ }
}
