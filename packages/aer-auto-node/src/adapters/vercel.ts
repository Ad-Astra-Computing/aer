// Vercel AI SDK adapter. Unlike the OpenAI/Anthropic client-method adapters, the
// AI SDK exposes free functions (generateText/streamText/generateObject/
// streamObject) on the `ai` module, and the model is an object (`.modelId`).
// We patch the module's function exports and read structured result metadata
// only (usage, finishReason, tool-call NAMES) - never generated text or tool
// arguments.
//
// Limitation (same as the other patches): a named import
// `import { generateText } from 'ai'` binds before the patch and is not
// captured; this adapter observes namespace/property access. See the README.

import { wrapCreate, patchMethod, type ProviderConfig, type LlmResponseMeta, type PolicyOptionSource } from './llm-core.js';
import { loadModule, type AdapterDeps, type AdapterInstall, type ProtoTarget } from './resolve.js';
import type { AdapterStats } from './stats.js';
import type { CollectorEvent } from '../session.js';

type Capture = (event: CollectorEvent) => void;

function isThenable(v: unknown): boolean {
  return !!v && (typeof v === 'object' || typeof v === 'function') &&
    typeof (v as { then?: unknown }).then === 'function';
}

function numOr(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Observe a Vercel AI SDK streaming result (StreamTextResult / StreamObjectResult)
 * by awaiting its usage / finishReason / toolCalls PROMISES - never its textStream
 * or fullStream (content). Returns the structured metadata once they settle, or
 * null if the value isn't a recognized streaming result (so the caller falls back
 * to a best-effort completion). Each promise is settled independently so one
 * rejection (or a missing field) never loses the others.
 */
async function vercelStreamResult(result: unknown): Promise<LlmResponseMeta | null> {
  if (!result || typeof result !== 'object') return null;
  const r = result as { usage?: unknown; finishReason?: unknown; toolCalls?: unknown };
  const usageP = isThenable(r.usage) ? (r.usage as Promise<unknown>) : null;
  const finishP = isThenable(r.finishReason) ? (r.finishReason as Promise<unknown>) : null;
  const toolsP = isThenable(r.toolCalls) ? (r.toolCalls as Promise<unknown>) : null;
  // Only the streaming result shape exposes these as promises; if none are
  // thenable this isn't a stream result we handle.
  if (!usageP && !finishP && !toolsP) return null;

  const [usageS, finishS, toolsS] = await Promise.allSettled([
    usageP ?? Promise.resolve(undefined),
    finishP ?? Promise.resolve(undefined),
    toolsP ?? Promise.resolve(undefined),
  ]);

  const meta: LlmResponseMeta = { tool_names: [] };
  if (usageS.status === 'fulfilled' && usageS.value && typeof usageS.value === 'object') {
    const u = usageS.value as { inputTokens?: unknown; outputTokens?: unknown; promptTokens?: unknown; completionTokens?: unknown };
    const input = numOr(u.inputTokens) ?? numOr(u.promptTokens);
    const output = numOr(u.outputTokens) ?? numOr(u.completionTokens);
    if (input != null) meta.input_tokens = input;
    if (output != null) meta.output_tokens = output;
  }
  if (finishS.status === 'fulfilled' && typeof finishS.value === 'string') meta.stop_reason = finishS.value;
  if (toolsS.status === 'fulfilled' && Array.isArray(toolsS.value)) {
    meta.tool_names = toolsS.value
      .map((tc) => (tc as { toolName?: unknown })?.toolName)
      .filter((n): n is string => typeof n === 'string');
  }
  return meta;
}

export function vercelConfig(streaming: boolean): ProviderConfig {
  return {
    provider: 'vercel',
    extractRequest(args) {
      const p = args[0] as { model?: unknown; tools?: unknown } | undefined;
      if (!p || typeof p !== 'object') return null;
      const model = p.model;
      const modelId = typeof model === 'string'
        ? model
        : (model && typeof model === 'object' ? (model as { modelId?: unknown }).modelId : undefined);
      if (typeof modelId !== 'string') return null;
      const tools = p.tools;
      return {
        provider: 'vercel',
        model: modelId,
        ...(streaming ? { streaming: true } : {}),
        ...(tools && typeof tools === 'object' ? { tools_available: Object.keys(tools).length } : {}),
      };
    },
    // Streaming (v1.1): the AI SDK exposes usage/finishReason/toolCalls as RESULT
    // PROMISES (not in-band chunks), so we observe those promises rather than tap
    // the textStream. Reads usage numbers, finish reason and tool NAMES only -
    // never textStream/fullStream content, generated text or tool args.
    ...(streaming ? { extractStreamResult: vercelStreamResult } : {}),
    extractResponse(response) {
      // streamText/streamObject: usage + finishReason resolve later (promises);
      // v1 records streaming:true at request time and skips token extraction.
      if (streaming) return null;
      if (!response || typeof response !== 'object') return null;
      const r = response as {
        usage?: { inputTokens?: unknown; outputTokens?: unknown; promptTokens?: unknown; completionTokens?: unknown };
        finishReason?: unknown;
        toolCalls?: unknown;
      };
      if (isThenable(r.usage)) return null; // safety: a streamed result
      const usage = r.usage ?? {};
      const input = (usage.inputTokens ?? usage.promptTokens) as unknown;
      const output = (usage.outputTokens ?? usage.completionTokens) as unknown;
      const tool_names = Array.isArray(r.toolCalls)
        ? r.toolCalls
          .map((tc) => (tc as { toolName?: unknown })?.toolName)
          .filter((n): n is string => typeof n === 'string')
        : [];
      if (typeof input !== 'number' && typeof output !== 'number' && typeof r.finishReason !== 'string' && tool_names.length === 0) {
        return null;
      }
      return {
        ...(typeof input === 'number' ? { input_tokens: input } : {}),
        ...(typeof output === 'number' ? { output_tokens: output } : {}),
        ...(typeof r.finishReason === 'string' ? { stop_reason: r.finishReason } : {}),
        tool_names,
      };
    },
  };
}

// Patched AI SDK functions and whether each one streams.
const FUNCTIONS: Array<[string, boolean]> = [
  ['generateText', false],
  ['streamText', true],
  ['generateObject', false],
  ['streamObject', true],
];

export function installVercelAdapter(capture: Capture, deps: AdapterDeps = {}, stats?: AdapterStats, policy?: PolicyOptionSource): AdapterInstall {
  const mod = (deps.resolveProto ?? defaultResolveModule)();
  if (!mod) return { enabled: false, uninstall: () => undefined };

  const uninstalls: Array<() => void> = [];
  let any = false;
  for (const [fn, streaming] of FUNCTIONS) {
    if (typeof mod[fn] === 'function') {
      uninstalls.push(patchMethod(mod, fn, (orig) => wrapCreate(orig, vercelConfig(streaming), capture, stats, policy), `vercel.${fn}`));
      any = true;
    }
  }
  return {
    enabled: any,
    uninstall: () => { for (const u of uninstalls) { try { u(); } catch { /* best-effort */ } } },
  };
}

function defaultResolveModule(): ProtoTarget | null {
  try {
    const mod = loadModule('ai') as Record<string, unknown> | null;
    if (!mod) return null;
    const target = (mod['default'] ?? mod) as ProtoTarget;
    return typeof target['generateText'] === 'function' || typeof target['streamText'] === 'function' ? target : null;
  } catch {
    return null;
  }
}
