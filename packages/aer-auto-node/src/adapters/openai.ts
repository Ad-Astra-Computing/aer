// OpenAI SDK adapter. Wraps chat.completions.create to emit llm.* / tool.* from
// structured response metadata (model, usage, finish_reason, tool-call names).
// Never reads prompts, message text, or tool-call arguments.

import { wrapCreate, patchMethod, type ProviderConfig, type PolicyOptionSource, type CommitOption } from './llm-core.js';
import { loadModule, type AdapterDeps, type AdapterInstall, type ProtoTarget } from './resolve.js';
import type { AdapterStats } from './stats.js';
import type { CollectorEvent } from '../session.js';

export const openaiConfig: ProviderConfig = {
  provider: 'openai',
  extractRequest(args) {
    const p = args[0] as { model?: unknown; stream?: unknown; tools?: unknown } | undefined;
    if (!p || typeof p !== 'object' || typeof p.model !== 'string') return null;
    return {
      provider: 'openai',
      model: p.model,
      ...(p.stream === true ? { streaming: true } : {}),
      ...(Array.isArray(p.tools) ? { tools_available: p.tools.length } : {}),
    };
  },
  extractResponse(response) {
    const r = response as {
      model?: unknown;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      choices?: unknown;
    } | null;
    if (!r || typeof r !== 'object' || (!('usage' in r) && !('choices' in r))) return null;

    const usage = r.usage ?? {};
    const choices = Array.isArray(r.choices) ? r.choices : [];
    const tool_names: string[] = [];
    let stop_reason: string | undefined;
    if (choices[0] && typeof choices[0].finish_reason === 'string') stop_reason = choices[0].finish_reason;
    for (const c of choices) {
      const tcs = (c as { message?: { tool_calls?: unknown } })?.message?.tool_calls;
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          const name = (tc as { function?: { name?: unknown } })?.function?.name;
          if (typeof name === 'string') tool_names.push(name);
        }
      }
    }
    return {
      ...(typeof r.model === 'string' ? { model: r.model } : {}),
      ...(typeof usage.prompt_tokens === 'number' ? { input_tokens: usage.prompt_tokens } : {}),
      ...(typeof usage.completion_tokens === 'number' ? { output_tokens: usage.completion_tokens } : {}),
      ...(stop_reason ? { stop_reason } : {}),
      tool_names,
    };
  },
  // Assembled response text for the response commitment (ADR-011). Concatenates
  // choice message content in order. Read only on the commitment path; one-way
  // hashed, never emitted.
  extractResponseText(response) {
    const r = response as { choices?: unknown } | null;
    if (!r || typeof r !== 'object' || !Array.isArray(r.choices)) return null;
    const parts: string[] = [];
    for (const c of r.choices) {
      const content = (c as { message?: { content?: unknown } })?.message?.content;
      if (typeof content === 'string') parts.push(content);
      else if (Array.isArray(content)) {
        for (const p of content) {
          const txt = (p as { text?: unknown })?.text;
          if (typeof txt === 'string') parts.push(txt);
        }
      }
    }
    return parts.length > 0 ? parts.join('') : null;
  },
  // Tool calls with arguments (ADR-011 slice 2). arguments is a JSON STRING in the
  // OpenAI shape; the commitment normalizes it so it matches Anthropic's object.
  extractToolCalls(response) {
    const r = response as { choices?: unknown } | null;
    if (!r || typeof r !== 'object' || !Array.isArray(r.choices)) return null;
    const calls: Array<{ name: string; args: unknown }> = [];
    for (const c of r.choices) {
      const tcs = (c as { message?: { tool_calls?: unknown } })?.message?.tool_calls;
      if (!Array.isArray(tcs)) continue;
      for (const tc of tcs) {
        const fn = (tc as { function?: { name?: unknown; arguments?: unknown } })?.function;
        if (typeof fn?.name === 'string') calls.push({ name: fn.name, args: fn.arguments });
      }
    }
    return calls.length > 0 ? calls : null;
  },
  // Tool RESULTS fed back into this request: OpenAI carries them as role:'tool'
  // messages. Commit the content (ADR-011 slice 2).
  extractToolResults(args) {
    const p = args[0] as { messages?: unknown } | undefined;
    if (!p || !Array.isArray(p.messages)) return null;
    const out: Array<{ content: unknown }> = [];
    for (const m of p.messages) {
      if (m && typeof m === 'object' && (m as { role?: unknown }).role === 'tool') {
        out.push({ content: (m as { content?: unknown }).content });
      }
    }
    return out.length > 0 ? out : null;
  },
  // Streaming response text delta (ADR-011 slice 2). Read only on the commitment
  // path; assembled + one-way hashed at stream end, never emitted.
  extractStreamText(chunk) {
    const c = chunk as { choices?: unknown } | null;
    if (!c || typeof c !== 'object' || !Array.isArray(c.choices)) return null;
    let text = '';
    for (const ch of c.choices) {
      const d = (ch as { delta?: { content?: unknown } })?.delta?.content;
      if (typeof d === 'string') text += d;
    }
    return text.length > 0 ? text : null;
  },
  // Streaming (v1.1): fold ChatCompletionChunk metadata. usage arrives on the
  // final chunk only when the caller set stream_options.include_usage; we read
  // it if present but never require it. tool-call NAMES appear in the delta that
  // opens each tool call; argument deltas are ignored.
  extractStreamChunk(chunk, acc) {
    const c = chunk as {
      model?: unknown;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } | null;
      choices?: unknown;
    } | null;
    if (!c || typeof c !== 'object') return;
    if (typeof c.model === 'string') acc.model = c.model;
    const u = c.usage;
    if (u && typeof u === 'object') {
      if (typeof u.prompt_tokens === 'number') acc.input_tokens = u.prompt_tokens;
      if (typeof u.completion_tokens === 'number') acc.output_tokens = u.completion_tokens;
    }
    const choices = Array.isArray(c.choices) ? c.choices : [];
    for (const ch of choices) {
      const fr = (ch as { finish_reason?: unknown }).finish_reason;
      if (typeof fr === 'string') acc.stop_reason = fr;
      const tcs = (ch as { delta?: { tool_calls?: unknown } }).delta?.tool_calls;
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          const name = (tc as { function?: { name?: unknown } })?.function?.name;
          if (typeof name === 'string' && name && !acc.tool_names.includes(name)) acc.tool_names.push(name);
        }
      }
    }
  },
};

type Capture = (event: CollectorEvent) => void;

export function installOpenAIAdapter(capture: Capture, deps: AdapterDeps = {}, stats?: AdapterStats, policy?: PolicyOptionSource, commit?: CommitOption): AdapterInstall {
  const proto = (deps.resolveProto ?? defaultResolveProto)();
  if (!proto) return { enabled: false, uninstall: () => undefined };
  const uninstall = patchMethod(proto, 'create', (orig) => wrapCreate(orig, openaiConfig, capture, stats, policy, commit), 'openai');
  return { enabled: true, uninstall };
}

function defaultResolveProto(): ProtoTarget | null {
  try {
    const mod = loadModule('openai') as Record<string, unknown> | null;
    if (!mod) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const OpenAI = (mod['default'] ?? mod['OpenAI'] ?? mod) as any;
    const proto = OpenAI?.Chat?.Completions?.prototype ?? OpenAI?.Completions?.prototype;
    return proto && typeof proto.create === 'function' ? (proto as ProtoTarget) : null;
  } catch {
    return null;
  }
}
