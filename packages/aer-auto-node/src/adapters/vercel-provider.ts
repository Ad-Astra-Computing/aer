// Vercel AI SDK, instrumented one layer below the facade.
//
// `ai`'s module namespace is sealed, so generateText and streamText cannot be
// wrapped in place. The provider packages underneath are ordinary classes with
// extensible prototypes, and one call to a model's doGenerate is one real
// model call, which is the unit a record should carry anyway.

import type { CollectorEvent } from '../session.js';
import type { AdapterInstall, ProtoTarget } from './resolve.js';
import { loadModuleCopies } from './resolve.js';
import { patchMethod } from './llm-core.js';
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
): Promise<AdapterInstall> {
  const uninstalls: Array<() => void> = [];

  for (const { pkg, factory, provider } of PROVIDERS) {
    try {
      for (const mod of await loadModuleCopies(pkg)) {
        for (const proto of protosOf(mod, factory)) {
          const gen = patchMethod(
            proto, 'doGenerate',
            (orig) => wrapModelCall(orig, provider, capture, stats, false),
            `vercel-provider.${provider}.doGenerate`,
          );
          if (gen) uninstalls.push(gen);
          const stream = patchMethod(
            proto, 'doStream',
            (orig) => wrapModelCall(orig, provider, capture, stats, true),
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

/**
 * Wrap one model call. The LanguageModel spec is uniform across providers:
 * the model id is on the instance, and doGenerate resolves with usage and a
 * finish reason. Nothing here reads the prompt or the generated text.
 */
function wrapModelCall(
  original: AnyFn,
  provider: string,
  capture: Capture,
  stats: AdapterStats | undefined,
  streaming: boolean,
): AnyFn {
  return function wrapped(this: unknown, ...args: unknown[]): unknown {
    const model = str((this as Record<string, unknown> | null)?.['modelId']);
    const base: Record<string, unknown> = { provider, ...(model !== undefined ? { model } : {}) };

    try {
      capture({ event_type: 'llm.requested', payload: { ...base, streaming } });
      stats?.record(provider, 'call');
    } catch { /* never break the call */ }

    let result: unknown;
    try {
      result = original.apply(this, args);
    } catch (err) {
      safeComplete(capture, stats, provider, base, undefined, false);
      throw err;
    }

    if (result instanceof Promise || (typeof result === 'object' && result !== null && typeof (result as PromiseLike<unknown>).then === 'function')) {
      return (result as Promise<unknown>).then(
        (value) => {
          // A stream resolves before its tokens exist; the counts arrive in
          // the finish part, which this slice does not read. Recording the
          // call without counts is honest; inventing them would not be.
          safeComplete(capture, stats, provider, base, streaming ? undefined : value, true);
          return value;
        },
        (err: unknown) => {
          safeComplete(capture, stats, provider, base, undefined, false);
          throw err;
        },
      );
    }

    safeComplete(capture, stats, provider, base, streaming ? undefined : result, true);
    return result;
  };
}

function safeComplete(
  capture: Capture,
  stats: AdapterStats | undefined,
  provider: string,
  base: Record<string, unknown>,
  value: unknown,
  ok: boolean,
): void {
  try {
    const payload: Record<string, unknown> = { ...base, ok };
    const v = value as Record<string, unknown> | undefined;
    const usage = v?.['usage'] as Record<string, unknown> | undefined;
    const input = tokenCount(usage?.['inputTokens']);
    const output = tokenCount(usage?.['outputTokens']);
    if (input !== undefined) payload['input_tokens'] = input;
    if (output !== undefined) payload['output_tokens'] = output;
    const stop = finishReasonOf(v?.['finishReason']);
    if (stop !== undefined) payload['stop_reason'] = stop;
    // The response can name a more specific model than the request asked for.
    const responded = str((v?.['response'] as Record<string, unknown> | undefined)?.['modelId']);
    if (responded !== undefined) payload['model'] = responded;

    capture({ event_type: 'llm.completed', payload });
    stats?.record(provider, ok ? 'ok' : 'error');
  } catch { /* never break the call */ }
}
