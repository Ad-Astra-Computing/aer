import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { buildSmokeScript } from './smoke-script.js';

describe('buildSmokeScript', () => {
  it('embeds the healthz URL derived from the target base URL', () => {
    const script = buildSmokeScript('https://api.aer.run');
    expect(script).toContain('https://api.aer.run/healthz');
  });

  it('does not mix top-level await with require, the exact cause of ERR_AMBIGUOUS_MODULE_SYNTAX', () => {
    const script = buildSmokeScript('https://api.aer.run');
    // The await must be inside a function (IIFE), not top-level.
    expect(script.trim().startsWith('(async () => {') || script.trim().startsWith('(async()=>{')).toBe(true);
    expect(script).toContain('require(');
  });

  it('runs under plain `node -e` (CJS) without ERR_AMBIGUOUS_MODULE_SYNTAX', () => {
    const script = buildSmokeScript('http://127.0.0.1:1'); // unreachable is fine, fetch is caught
    // Should exit 0 and must not throw/print ERR_AMBIGUOUS_MODULE_SYNTAX.
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(out).toBeDefined();
  });
});
