// Anthropic SDK adapter. Wraps messages.create to emit llm.* / tool.* from
// structured response metadata (model, usage, stop_reason, tool_use names).
// Never reads prompts, message content text, or tool inputs.

import { wrapCreate, patchMethod, type ProviderConfig, type PolicyOptionSource, type CommitOption } from './llm-core.js';
import { loadModule, type AdapterDeps, type AdapterInstall, type ProtoTarget } from './resolve.js';
import type { AdapterStats } from './stats.js';
import type { CollectorEvent } from '../session.js';

export const anthropicConfig: ProviderConfig = {
  provider: 'anthropic',
  extractRequest(args) {
    const p = args[0] as { model?: unknown; stream?: unknown; tools?: unknown } | undefined;
    if (!p || typeof p !== 'object' || typeof p.model !== 'string') return null;
    return {
      provider: 'anthropic',
      model: p.model,
      ...(p.stream === true ? { streaming: true } : {}),
      ...(Array.isArray(p.tools) ? { tools_available: p.tools.length } : {}),
    };
  },
  extractResponse(response) {
    const r = response as {
      model?: unknown;
      stop_reason?: unknown;
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
      content?: unknown;
    } | null;
    if (!r || typeof r !== 'object' || (!('usage' in r) && !('content' in r))) return null;

    const usage = r.usage ?? {};
    const content = Array.isArray(r.content) ? r.content : [];
    const tool_names: string[] = [];
    for (const block of content) {
      const b = block as { type?: unknown; name?: unknown };
      if (b?.type === 'tool_use' && typeof b.name === 'string') tool_names.push(b.name);
    }
    return {
      ...(typeof r.model === 'string' ? { model: r.model } : {}),
      ...(typeof usage.input_tokens === 'number' ? { input_tokens: usage.input_tokens } : {}),
      ...(typeof usage.output_tokens === 'number' ? { output_tokens: usage.output_tokens } : {}),
      ...(typeof r.stop_reason === 'string' ? { stop_reason: r.stop_reason } : {}),
      tool_names,
    };
  },
  // Assembled response text for the response commitment (ADR-011). Concatenates
  // the text of each text block in order. Read only on the commitment path;
  // one-way hashed, never emitted.
  extractResponseText(response) {
    const r = response as { content?: unknown } | null;
    if (!r || typeof r !== 'object' || !Array.isArray(r.content)) return null;
    const parts: string[] = [];
    for (const block of r.content) {
      const b = block as { type?: unknown; text?: unknown };
      if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    }
    return parts.length > 0 ? parts.join('') : null;
  },
  // Tool calls with arguments (ADR-011 slice 2). Anthropic tool_use.input is
  // already an object; commits to the same tag as OpenAI's JSON-string arguments.
  extractToolCalls(response) {
    const r = response as { content?: unknown } | null;
    if (!r || typeof r !== 'object' || !Array.isArray(r.content)) return null;
    const calls: Array<{ name: string; args: unknown }> = [];
    for (const block of r.content) {
      const b = block as { type?: unknown; name?: unknown; input?: unknown };
      if (b?.type === 'tool_use' && typeof b.name === 'string') calls.push({ name: b.name, args: b.input });
    }
    return calls.length > 0 ? calls : null;
  },
  // Tool RESULTS fed back into this request: Anthropic carries them as tool_result
  // blocks inside user messages. Commit each block's content (ADR-011 slice 2).
  extractToolResults(args) {
    const p = args[0] as { messages?: unknown } | undefined;
    if (!p || !Array.isArray(p.messages)) return null;
    const out: Array<{ content: unknown }> = [];
    for (const m of p.messages) {
      const content = (m as { content?: unknown })?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const b = block as { type?: unknown; content?: unknown };
        if (b?.type === 'tool_result') out.push({ content: b.content });
      }
    }
    return out.length > 0 ? out : null;
  },
  // Streaming response text delta (ADR-011 slice 2): content_block_delta of type
  // text_delta. Read only on the commitment path; assembled + hashed at stream end.
  extractStreamText(event) {
    const e = event as { type?: unknown; delta?: { type?: unknown; text?: unknown } } | null;
    if (!e || typeof e !== 'object' || e.type !== 'content_block_delta') return null;
    const d = e.delta;
    if (d && d.type === 'text_delta' && typeof d.text === 'string') return d.text;
    return null;
  },
  // Streaming (v1.1): fold the Anthropic message-stream events. input_tokens
  // arrive on message_start, output_tokens + stop_reason on message_delta, and
  // tool_use NAMES on content_block_start. content_block_delta carries text /
  // input_json deltas and is intentionally ignored (bodies OFF).
  extractStreamChunk(event, acc) {
    const e = event as { type?: unknown } | null;
    if (!e || typeof e !== 'object') return;
    if (e.type === 'message_start') {
      const m = (e as { message?: { model?: unknown; usage?: { input_tokens?: unknown } } }).message;
      if (typeof m?.model === 'string') acc.model = m.model;
      if (typeof m?.usage?.input_tokens === 'number') acc.input_tokens = m.usage.input_tokens;
    } else if (e.type === 'content_block_start') {
      const cb = (e as { content_block?: { type?: unknown; name?: unknown } }).content_block;
      if (cb?.type === 'tool_use' && typeof cb.name === 'string' && cb.name && !acc.tool_names.includes(cb.name)) {
        acc.tool_names.push(cb.name);
      }
    } else if (e.type === 'message_delta') {
      const d = e as { delta?: { stop_reason?: unknown }; usage?: { output_tokens?: unknown } };
      if (typeof d.delta?.stop_reason === 'string') acc.stop_reason = d.delta.stop_reason;
      if (typeof d.usage?.output_tokens === 'number') acc.output_tokens = d.usage.output_tokens;
    }
  },
};

type Capture = (event: CollectorEvent) => void;

export function installAnthropicAdapter(capture: Capture, deps: AdapterDeps = {}, stats?: AdapterStats, policy?: PolicyOptionSource, commit?: CommitOption): AdapterInstall {
  const proto = (deps.resolveProto ?? defaultResolveProto)();
  if (!proto) return { enabled: false, uninstall: () => undefined };
  const uninstall = patchMethod(proto, 'create', (orig) => wrapCreate(orig, anthropicConfig, capture, stats, policy, commit), 'anthropic');
  return { enabled: true, uninstall };
}

function defaultResolveProto(): ProtoTarget | null {
  try {
    const mod = loadModule('@anthropic-ai/sdk') as Record<string, unknown> | null;
    if (!mod) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Anthropic = (mod['default'] ?? mod['Anthropic'] ?? mod) as any;
    const proto = Anthropic?.Messages?.prototype;
    return proto && typeof proto.create === 'function' ? (proto as ProtoTarget) : null;
  } catch {
    return null;
  }
}
