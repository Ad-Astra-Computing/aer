// Read token usage off a Codex CLI rollout transcript's `token_usage_record`
// line, never a `response_item` line (which can carry prompt/completion
// content, tool args or tool results).
//
// This shape is read from the openai/codex source, not a documented or
// versioned contract (Codex's own hooks docs say the transcript format may
// change without notice). See this change's commit message for the exact
// source files and struct fields this was checked against; re-check them if
// Codex stops emitting a matching line.

import { identifierField } from './model-usage.js';

export interface CodexUsage {
  responseId: string;
  turnId?: string;
  inputTokens?: number;
  outputTokens?: number;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function tokenCount(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : undefined;
}

// Undefined means "not a usable token_usage_record"; callers skip the line
// rather than record a partial marker. Only `usage.input_tokens` and
// `usage.output_tokens` are read off `usage`: no other field of TokenUsage
// (and none of turn_token_usage/thread_token_usage, which are running totals,
// not this response's own count) is recorded here.
export function extractCodexUsage(entry: unknown): CodexUsage | undefined {
  const e = isObj(entry) ? entry : undefined;
  if (!e || e['type'] !== 'token_usage_record') return undefined;
  const payload = isObj(e['payload']) ? e['payload'] : undefined;
  if (!payload) return undefined;
  const responseId = identifierField(payload['response_id']);
  if (!responseId) return undefined;
  const usage = isObj(payload['usage']) ? payload['usage'] : undefined;
  const out: CodexUsage = { responseId };
  const turnId = identifierField(payload['turn_id']);
  if (turnId !== undefined) out.turnId = turnId;
  const inputTokens = tokenCount(usage?.['input_tokens']);
  if (inputTokens !== undefined) out.inputTokens = inputTokens;
  const outputTokens = tokenCount(usage?.['output_tokens']);
  if (outputTokens !== undefined) out.outputTokens = outputTokens;
  return out;
}
