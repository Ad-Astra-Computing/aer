// Read the model and token counts off a Claude Code transcript assistant
// message, never `message.content` (prompt/completion text, tool args).
//
// SOURCE OF TRUTH; scripts/check-vendored.mjs fails the build on drift.

// Mirror of @aer/schemas event.ts MAX_FIELD_LEN.
const MAX_FIELD_LEN = 512;

export interface ClaudeCodeUsage {
  model: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function field(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_FIELD_LEN ? v : undefined;
}

function tokenCount(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : undefined;
}

function providerOf(model: string): string | undefined {
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
  const model = field(msg['model']);
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
