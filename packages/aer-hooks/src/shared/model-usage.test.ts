// providerOf: model string -> vendor. Fixture values are real model strings
// pulled from this machine's own local Codex session history (~/.codex/
// sessions/**/*.jsonl), not invented, so a prefix check that looks plausible
// but misses a real shape (e.g. a bare codename with no 'gpt-' prefix) is
// caught here instead of silently losing provider attribution in production.

import { describe, it, expect } from 'vitest';
import { providerOf } from './model-usage.js';

describe('providerOf', () => {
  it.each([
    'gpt-4o', 'gpt-5', 'gpt-5.1-codex', 'gpt-5.3-codex', 'gpt-5.5', 'gpt-5.6',
    'gpt-5.6-astra', 'gpt-5.6-sol', 'gpt-5-codex', 'gpt-6-astra', 'gpt-6-sol',
    'gpt-astra',
  ])('resolves a real gpt-prefixed Codex model (%s) to openai', (model) => {
    expect(providerOf(model)).toBe('openai');
  });

  it.each(['astra', 'codex-astra'])(
    'resolves a bare OpenAI codename with no gpt prefix (%s) to openai',
    (model) => {
      expect(providerOf(model)).toBe('openai');
    },
  );

  it('resolves a Claude model to anthropic', () => {
    expect(providerOf('claude-opus-5-5')).toBe('anthropic');
  });

  it('resolves a Gemini model to google, not antigravity', () => {
    // providerOf maps vendor, never harness. Antigravity sets meta.harness
    // directly and unconditionally (normalizeAntigravity), independent of
    // model name, so this function never even runs on real Antigravity data.
    expect(providerOf('gemini-3-pro')).toBe('google');
  });

  it('returns undefined for an unrecognized model, never a guess', () => {
    expect(providerOf('nonexistent-model-xyz')).toBeUndefined();
  });

  it('does not let a codename token steal a differently-prefixed model', () => {
    // 'sol'/'luna' must be a token match, not a substring, and gemini is
    // checked before the codename fallback, not after.
    expect(providerOf('gemini-sol-flash')).toBe('google');
  });

  it('does not let a codename substring false-positive on an unrelated vendor', () => {
    // Upstage's real Solar family; the '-solar' substring must never match
    // the '-sol' codename token.
    expect(providerOf('upstage-solar-pro')).toBeUndefined();
    expect(providerOf('some-lunar-x')).toBeUndefined();
  });
});
