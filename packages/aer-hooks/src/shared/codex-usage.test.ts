// extractCodexUsage reads a Codex CLI rollout transcript's token_usage_record
// line, never a ResponseItem (which can carry prompt/completion content).
//
// The rollout wire shape is not documented for end users: Codex's own hooks
// docs call the transcript "not a stable interface," so this is read from the
// openai/codex source (codex-rs/protocol/src/protocol.rs's
// TokenUsageRecord/TokenUsage, codex-rs/history/src/lib.rs's RolloutLine).
// These fixtures mirror that shape exactly.

import { describe, it, expect } from 'vitest';
import { extractCodexUsage, extractCodexSessionMeta } from './codex-usage.js';

function tokenUsageRecordLine(opts: Partial<{
  responseId: string;
  turnId: string;
  inputTokens: number;
  outputTokens: number;
}> = {}): Record<string, unknown> {
  const usage = {
    input_tokens: opts.inputTokens ?? 11,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: opts.outputTokens ?? 22,
    reasoning_output_tokens: 0,
    total_tokens: (opts.inputTokens ?? 11) + (opts.outputTokens ?? 22),
  };
  return {
    timestamp: '2026-10-12T00:00:00.000Z',
    type: 'token_usage_record',
    payload: {
      thread_id: 'thr_1',
      turn_id: opts.turnId ?? 'turn_1',
      session_id: 'ses_1',
      root_turn_id: opts.turnId ?? 'turn_1',
      response_id: opts.responseId ?? 'resp_1',
      usage,
      turn_token_usage: usage,
      thread_token_usage: usage,
    },
  };
}

describe('extractCodexUsage', () => {
  it('reads response id, turn id and token counts off a token_usage_record', () => {
    const out = extractCodexUsage(tokenUsageRecordLine({ responseId: 'resp_abc', turnId: 'turn_xyz', inputTokens: 7, outputTokens: 99 }));
    expect(out).toEqual({ responseId: 'resp_abc', turnId: 'turn_xyz', inputTokens: 7, outputTokens: 99 });
  });

  it('is undefined for any other rollout item type (never reads a ResponseItem)', () => {
    expect(extractCodexUsage({
      type: 'response_item',
      payload: { content: [{ type: 'input_text', text: 'SECRET-PROMPT' }] },
    })).toBeUndefined();
  });

  it('is undefined with no response id', () => {
    const line = tokenUsageRecordLine();
    (line['payload'] as Record<string, unknown>)['response_id'] = undefined;
    expect(extractCodexUsage(line)).toBeUndefined();
  });

  it('is undefined for a non-object, a non-object payload, or a non-identifier response id', () => {
    expect(extractCodexUsage(null)).toBeUndefined();
    expect(extractCodexUsage('token_usage_record')).toBeUndefined();
    expect(extractCodexUsage({ type: 'token_usage_record', payload: 'x' })).toBeUndefined();
    expect(extractCodexUsage({ type: 'token_usage_record', payload: { response_id: 'free text with spaces' } })).toBeUndefined();
  });

  it('omits turn id and token counts rather than guessing when they are missing or malformed', () => {
    expect(extractCodexUsage({ type: 'token_usage_record', payload: { response_id: 'resp_1' } }))
      .toEqual({ responseId: 'resp_1' });
    expect(extractCodexUsage({
      type: 'token_usage_record',
      payload: { response_id: 'resp_1', usage: { input_tokens: 'not-a-number', output_tokens: -5 } },
    })).toEqual({ responseId: 'resp_1' });
  });

  it('never reads the usage.codex_rollout_budget_units or any other field off the record', () => {
    const line = tokenUsageRecordLine();
    (line['payload'] as Record<string, unknown>)['usage'] = {
      ...(line['payload'] as Record<string, unknown>)['usage'] as Record<string, unknown>,
      codex_rollout_budget_units: 'SECRET-BUDGET',
    };
    const out = extractCodexUsage(line);
    expect(JSON.stringify(out)).not.toContain('SECRET-BUDGET');
  });
});

// Trimmed from a real local rollout's session_meta line (first line of
// ~/.codex/sessions/2026/10/06/rollout-...jsonl): base_instructions (the
// full system prompt) and every other field this function does not read are
// left out, since this is a fixture shape check, not a content fixture.
function sessionMetaLine(provider: unknown): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    session_id: 'ses_1',
    originator: 'codex_exec',
    cli_version: '0.155.0',
  };
  if (provider !== undefined) payload['model_provider'] = provider;
  return { timestamp: '2026-10-06T07:27:16.660Z', ordinal: 0, type: 'session_meta', payload };
}

describe('extractCodexSessionMeta', () => {
  it('reads the provider off a real session_meta shape', () => {
    expect(extractCodexSessionMeta(sessionMetaLine('openai'))).toEqual({ provider: 'openai' });
  });

  it('passes through any provider value verbatim, never an allowlist of known ones', () => {
    // A future vendor rename or backend generation this package has never
    // seen must still resolve correctly, since this field is read directly
    // off the transcript rather than matched against a known-name list.
    expect(extractCodexSessionMeta(sessionMetaLine('openai-gen8'))).toEqual({ provider: 'openai-gen8' });
    expect(extractCodexSessionMeta(sessionMetaLine('ollama'))).toEqual({ provider: 'ollama' });
  });

  it('is undefined for any other rollout item type (never reads turn_context or a response_item)', () => {
    expect(extractCodexSessionMeta({ type: 'turn_context', payload: { model: 'gpt-6-sol' } })).toBeUndefined();
    expect(extractCodexSessionMeta({ type: 'response_item', payload: {} })).toBeUndefined();
  });

  it('is undefined for a non-object, a non-object payload, or a missing/malformed provider', () => {
    expect(extractCodexSessionMeta(null)).toBeUndefined();
    expect(extractCodexSessionMeta({ type: 'session_meta', payload: 'x' })).toBeUndefined();
    expect(extractCodexSessionMeta(sessionMetaLine(undefined))).toBeUndefined();
    expect(extractCodexSessionMeta(sessionMetaLine('free text with spaces'))).toBeUndefined();
  });

  it('never reads base_instructions or anything else off the record', () => {
    const line = sessionMetaLine('openai');
    (line['payload'] as Record<string, unknown>)['base_instructions'] = { text: 'SECRET-SYSTEM-PROMPT' };
    const out = extractCodexSessionMeta(line);
    expect(JSON.stringify(out)).not.toContain('SECRET-SYSTEM-PROMPT');
  });
});
