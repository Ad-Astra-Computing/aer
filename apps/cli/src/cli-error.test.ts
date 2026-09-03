import { describe, it, expect } from 'vitest';
import { formatCliError } from './cli-error.js';

describe('formatCliError', () => {
  it('returns just the message for an Error, never a raw stack trace', () => {
    const err = new Error('ingest failed: 500 boom');
    const out = formatCliError(err);
    expect(out).toBe('ingest failed: 500 boom');
    expect(out).not.toContain('\n');
    expect(out).not.toContain('at ');
    expect(out).not.toContain(import.meta.url.replace('file://', ''));
  });

  it('passes through a plain string', () => {
    expect(formatCliError('boom')).toBe('boom');
  });

  it('stringifies an arbitrary thrown value without throwing', () => {
    expect(formatCliError({ code: 42 })).toBe('{"code":42}');
  });
});
