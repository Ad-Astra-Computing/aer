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
// Maps a MODEL to its vendor, never to the harness/product that ran it
// (that's `meta.harness`, set independently per event). Checked against real
// local Codex session history AND the live model picker's full list
// (gpt-6-astra/sol/luna, gpt-5.6-sol/terra/luna): every gpt-prefixed form
// already resolves through the gpt check below regardless of codename, but a
// bare codename ('astra', 'codex-astra') also appears in real data, hence
// this list as a fallback. o1/o3/o4 stay listed anyway since a non-Codex
// OpenAI API caller could still report one directly.
const OPENAI_CODENAMES = ['astra', 'sol', 'luna', 'terra'];

export function providerOf(model: string): string | undefined {
  const m = model.toLowerCase();
  if (m.startsWith('claude')) return 'anthropic';
  if (m.startsWith('gpt') || m.startsWith('codex') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) return 'openai';
  // Antigravity runs on Gemini (see normalizeAntigravity in normalize.ts)
  // but that's a harness fact, not a vendor one: it never calls this.
  if (m.startsWith('gemini')) return 'google';
  // Least specific signal, checked last: a '.'/'-' delimited token match, not
  // a substring, so 'solar-pro' (Upstage) and 'lunar-x' never false-positive.
  const tokens = m.split(/[-.]/);
  if (OPENAI_CODENAMES.some((name) => tokens.includes(name))) return 'openai';
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
