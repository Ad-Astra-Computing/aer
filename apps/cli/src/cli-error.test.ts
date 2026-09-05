import { describe, it, expect } from 'vitest';
import { formatCliError, sanitizeForTerminal } from './cli-error.js';

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

  it('strips ANSI escapes and bell characters from a server error body', () => {
    const body = '\x1b[31mINJECTED-RED-TEXT\x1b[0m\x07 NORMAL_TAIL_TEXT';
    const out = formatCliError(new Error(`404 ${body}`));
    expect(out).not.toMatch(/[\x00-\x08\x0B-\x1F\x7F]/);
    expect(out).toContain('NORMAL_TAIL_TEXT');
  });

  it('keeps tabs and newlines but truncates a very long message', () => {
    const long = 'x'.repeat(5000);
    const out = formatCliError(new Error(long));
    expect(out.length).toBeLessThan(5000);
    expect(out).toContain('[truncated]');
  });
});

describe('sanitizeForTerminal', () => {
  it('removes control characters except tab and newline', () => {
    // \x07 (bell) and \x1b (ESC) are stripped; the printable characters that
    // followed the ESC in a real ANSI sequence ("[31m") are left as inert text.
    const input = 'line one\tcol\nline two\x07\x1b[31m';
    expect(sanitizeForTerminal(input)).toBe('line one\tcol\nline two[31m');
  });
});
