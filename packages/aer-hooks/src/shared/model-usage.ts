// Model/provider identification shared across every transcript harness this
// repo reads, plus the Claude Code-specific assistant-message extractor.
// `identifierField` and `providerOf` are harness-agnostic and reused by
// codex-transcript.ts; `extractClaudeCodeUsage` reads Claude Code's own
// assistant-message shape (`message.model`, `message.usage.*`) specifically,
// never `message.content` (prompt/completion text, tool args).
//
// SOURCE OF TRUTH; scripts/check-vendored.mjs fails the build on drift.

// Mirror of normalize.ts's identifier(): closed charset, length-capped. A
// model name or agent type that does not fit this shape is unrecognized, not
// truncated to fit.
const IDENTIFIER_MAX_LEN = 128;
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]*$/;

export interface ClaudeCodeUsage {
  model: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Shared by this file (model) and transcript-tail.ts (agentType).
export function identifierField(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length === 0 || v.length > IDENTIFIER_MAX_LEN) return undefined;
  return IDENTIFIER_RE.test(v) ? v : undefined;
}

function tokenCount(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : undefined;
}

// Exported for reuse by codex-transcript.ts: a Codex transcript's
// token_usage_record carries no provider of its own, so the caller derives
// one from the model string this same way.
//
// This maps a MODEL to the company that trained it, never to the harness/
// product that surfaced the call (that's `meta.harness`, set independently
// per event: 'claude-code' | 'codex' | 'opencode' | 'antigravity'). A Gemini
// model is provider 'google' regardless of which harness ran it - Antigravity
// is Google's own agent product and a harness, not a provider, and today
// emits no per-call model/token data at all to map here (confirmed dead end,
// see the Antigravity usage-metadata doc). o1/o3/o4 stay listed even though
// o1 is superseded: an older transcript can still reference it, and a prefix
// check costs nothing to keep. gpt-5.1-codex and similar Codex-branded model
// names already match the 'gpt' prefix, so they correctly resolve to
// 'openai' here; 'codex' itself is a harness label, never a provider.
export function providerOf(model: string): string | undefined {
  const m = model.toLowerCase();
  if (m.startsWith('claude')) return 'anthropic';
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) return 'openai';
  if (m.startsWith('gemini')) return 'google';
  return undefined;
}

// Undefined means "no usable model"; callers skip the entry rather than
// record a partial marker.
export function extractClaudeCodeUsage(message: unknown): ClaudeCodeUsage | undefined {
  const msg = isObj(message) ? message : undefined;
  if (!msg) return undefined;
  const model = identifierField(msg['model']);
  if (!model) return undefined;
  const usage = isObj(msg['usage']) ? msg['usage'] : undefined;
  const usageOut: ClaudeCodeUsage = { model };
  const provider = providerOf(model);
  if (provider !== undefined) usageOut.provider = provider;
  const inputTokens = tokenCount(usage?.['input_tokens']);
  if (inputTokens !== undefined) usageOut.inputTokens = inputTokens;
  const outputTokens = tokenCount(usage?.['output_tokens']);
  if (outputTokens !== undefined) usageOut.outputTokens = outputTokens;
  return usageOut;
}
